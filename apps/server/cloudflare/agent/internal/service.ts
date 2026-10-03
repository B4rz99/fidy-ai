import {
  type AgentEnvironment,
  type AgentService,
  type AgentServiceInput,
  type HostedCommitFence,
  HostedDeliveryAdmission,
  HostedProgressAdmission,
  HostedTurnAdmission,
  pendingExecutionRecoveryMs,
} from "../contract";
import { BatchCalls, type CanonicalWork } from "../../canonical-operations/contract";
import {
  canonicalWorkRequiresInference,
  executeCanonicalWork,
} from "../../canonical-operations/operations";
import {
  type CanonicalToolEvidence,
  type TranscriptText,
  type TranscriptTurnId,
} from "../../../src/core/agent/contract";
import { UserId } from "../../../src/core/identity/contract";
import { type CanonicalOperationId } from "../../../src/core/canonical-operations/contract";
import { atomicBatchOperation } from "../../../src/shell/operations/contract";
import type { HostedInferenceService } from "../../../src/shell/hosted-inference/contract";
import { makeHostedSender } from "../../../src/shell/channels/whatsapp/runtime";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  type Scope,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import {
  type HostedDeliveryCorrelationToken,
  type WhatsAppProviderMessageId,
} from "../../../src/shell/channels/whatsapp/contract";
import {
  acknowledgeBrowserTurn,
  browserHostedDelivery,
  completeHostedTurnWithAdmission,
  completeWhatsAppTurnWithAdmission,
  readHostedProgress,
  resumeWhatsAppTurn,
} from "./hosted-turn";
import { expireHostedPending, finishHostedTurn } from "./turn-store";
import { makeUserCloudflareHostedInference, optionalHostedInference } from "../../ai/runtime";
import { transactionNow, transactionUnavailable } from "../../canonical-work/operations";
import {
  cloudflareWorkerTelemetry,
  observeProviderFetch,
} from "../../runtime/telemetry/operations";
import {
  WhatsAppStatusAdmission as StatusAdmission,
  WhatsAppTurnAdmission as TurnAdmission,
  WhatsAppHostedSubject,
  type WhatsAppTurnAdmission,
  WhatsAppWork,
} from "../../whatsapp/contract";
import { classifyWhatsAppAdmission, reconcileWhatsAppStatus } from "../../whatsapp/operations";

const digestBytes = 32;
const HTTP_ACCEPTED = 202;

const sendWhatsAppAttempt = ({
  sender,
  admission,
  text,
  correlationToken,
}: Readonly<{
  sender: ReturnType<typeof makeHostedSender>;
  admission: Pick<WhatsAppTurnAdmission, "bsuid" | "businessPhoneNumberId">;
  text: TranscriptText;
  correlationToken: HostedDeliveryCorrelationToken;
}>): Promise<
  | Readonly<{ kind: "accepted"; messageId: WhatsAppProviderMessageId }>
  | Readonly<{ kind: "ambiguous" | "rejected" }>
> =>
  Effect.runPromiseExit(
    sender({
      recipient: admission.bsuid,
      businessPhoneNumberId: admission.businessPhoneNumberId,
      text,
      correlationToken,
    })
  ).then((outcome) =>
    Exit.isSuccess(outcome)
      ? { kind: "accepted" as const, messageId: outcome.value.messageEvidence.providerMessageId }
      : {
          kind: Option.match(Cause.findErrorOption(outcome.cause), {
            onSome: (failure) => failure.deliveryCertainty,
            onNone: () => "ambiguous" as const,
          }),
        }
  );

const prepareWhatsAppExecution = (
  environment: AgentEnvironment,
  userId: string,
  admittedTurnId: () => Option.Option<TranscriptTurnId>
): Effect.Effect<
  Option.Option<
    Readonly<{
      inference: HostedInferenceService;
      sender: ReturnType<typeof makeHostedSender>;
    }>
  >,
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    if (environment.KAPSO_API_KEY === undefined || environment.KAPSO_API_KEY.length === 0) {
      return Option.none();
    }
    const inference = yield* Effect.exit(
      makeUserCloudflareHostedInference({ environment, db: environment.DB, userId, admittedTurnId })
    );
    if (Exit.isFailure(inference)) return Option.none();
    const clients = yield* Layer.build(FetchHttpClient.layer);
    const sender = makeHostedSender({
      apiKey: Redacted.make(environment.KAPSO_API_KEY),
      httpClient: Context.get(clients, HttpClient.HttpClient),
    });
    return Option.some({ inference: inference.value, sender });
  });

const startWhatsAppTurn = ({
  db,
  proof,
  inference,
  sender,
  signal,
  scheduleRecovery,
  onAdmitted,
}: Readonly<{
  db: D1Database;
  proof: WhatsAppTurnAdmission;
  inference: HostedInferenceService;
  sender: ReturnType<typeof makeHostedSender>;
  signal: AbortSignal;
  scheduleRecovery: (dueAtMs: number) => Promise<void>;
  onAdmitted: (turnId: TranscriptTurnId) => void;
}>): Promise<Response> =>
  completeWhatsAppTurnWithAdmission({
    input: {
      db,
      subject: WhatsAppHostedSubject.make({
        userId: proof.userId,
        portfolioId: proof.portfolioId,
        bsuid: proof.bsuid,
      }),
      inbound: {
        messageId: proof.messageId,
        businessPhoneNumberId: proof.businessPhoneNumberId,
        occurredAtMs: proof.occurredAtMs,
        receivedAtMs: proof.receivedAtMs,
      },
      text: proof.text,
      inference,
      bucket: Option.none(),
      executeMutation: Option.none(),
      deliver: {
        _tag: "WhatsApp",
        send: ({ text, correlationToken }) =>
          sendWhatsAppAttempt({ sender, admission: proof, text, correlationToken }),
      },
      signal,
      scheduleRecovery,
    },
    onAdmitted,
  });

const hostedResponseDeadlineMs = 25_000;
/** A soft response deadline; admission/preflight is interrupted, committed work is not. */
const hostedDeadline = (
  signal: AbortSignal
): Readonly<{
  signal: AbortSignal;
  processing: Promise<Response>;
  admittedTurnId: () => Option.Option<TranscriptTurnId>;
  onAdmitted: (turnId: TranscriptTurnId) => void;
  cancel: () => void;
}> => {
  let admittedTurnId = Option.none<TranscriptTurnId>();
  const preflight = new AbortController();
  const pending = Deferred.makeUnsafe<Response>();
  let timer = Effect.runFork(
    Effect.sleep(Duration.millis(hostedResponseDeadlineMs)).pipe(
      Effect.tap(() => Effect.sync(() => preflight.abort())),
      Effect.flatMap(() => Deferred.succeed(pending, transactionUnavailable())),
      Effect.asVoid
    )
  );
  const cancel = (): void => {
    Effect.runFork(Fiber.interrupt(timer));
  };
  const onAdmitted = (turnId: TranscriptTurnId): void => {
    admittedTurnId = Option.some(turnId);
    cancel();
    timer = Effect.runFork(
      Effect.sleep(Duration.millis(hostedResponseDeadlineMs)).pipe(
        Effect.flatMap(() =>
          Deferred.succeed(
            pending,
            Response.json(
              { status: "processing", turnId },
              { status: HTTP_ACCEPTED, headers: { "cache-control": "no-store" } }
            )
          )
        ),
        Effect.asVoid
      )
    );
  };
  return {
    processing: Effect.runPromise(Deferred.await(pending)),
    admittedTurnId: () => admittedTurnId,
    onAdmitted,
    cancel,
    signal: AbortSignal.any([signal, preflight.signal]),
  };
};

/** Recover a stalled owner before freeing the per-User queue. A later canonical commit must pass
 * the pending-Turn fence inside the same D1 batch, so it cannot commit after recovery.
 */
const boundedHostedOwner = ({
  ownerSettled,
  recover,
}: Readonly<{ ownerSettled: Promise<void>; recover: () => Promise<void> }>): Promise<void> => {
  const cancellation = new AbortController();
  const recovered = Effect.runPromise(
    Effect.sleep(Duration.millis(pendingExecutionRecoveryMs + hostedResponseDeadlineMs)).pipe(
      Effect.flatMap(() =>
        Effect.tryPromise(recover).pipe(Effect.retry(Schedule.spaced(Duration.seconds(1))))
      )
    ),
    { signal: cancellation.signal }
  ).then(
    () => undefined,
    () => ownerSettled
  );
  return Promise.race([ownerSettled, recovered]).finally(() => cancellation.abort());
};

const recoverAbandonedWork = (owner: AgentServiceInput): Promise<void> => {
  const env = owner.environment;
  const state = { storage: { setAlarm: owner.scheduleRecovery } };
  return Effect.runPromise(
    Effect.gen(function* () {
      const next = yield* expireHostedPending({
        db: env.DB,
        userId: owner.userId,
        now: transactionNow(),
      });
      if (Option.isSome(next)) {
        yield* Effect.tryPromise(() => state.storage.setAlarm(next.value));
      }
    })
  );
};

const runHostedReceipt = (owner: AgentServiceInput, request: Request): Promise<Response> => {
  const userId = owner.userId;
  const env = owner.environment;
  return Effect.runPromise(
    Effect.gen(function* () {
      const candidate = yield* Effect.tryPromise(() => request.json()).pipe(
        Effect.orElseSucceed(() => undefined)
      );
      const admission = Schema.decodeUnknownOption(HostedDeliveryAdmission)(candidate);
      if (
        Option.isNone(admission) ||
        admission.value.userId !== userId ||
        admission.value.digest.length !== digestBytes
      ) {
        return transactionUnavailable();
      }
      return yield* Effect.tryPromise(() =>
        acknowledgeBrowserTurn({
          db: env.DB,
          subject: {
            userId,
            id: admission.value.sessionId,
            digest: new Uint8Array(admission.value.digest),
          },
          turnId: admission.value.turnId,
          receipt: admission.value.receipt,
        })
      ).pipe(Effect.orElseSucceed(transactionUnavailable));
    })
  );
};

const runHostedProgress = (owner: AgentServiceInput, request: Request): Promise<Response> => {
  const userId = owner.userId;
  const env = owner.environment;
  const state = { storage: { setAlarm: owner.scheduleRecovery } };
  return Effect.runPromise(
    Effect.gen(function* () {
      const candidate = yield* Effect.tryPromise(() => request.json()).pipe(
        Effect.orElseSucceed(() => undefined)
      );
      const admission = Schema.decodeUnknownOption(HostedProgressAdmission)(candidate);
      if (
        Option.isNone(admission) ||
        admission.value.userId !== userId ||
        admission.value.digest.length !== digestBytes
      ) {
        return transactionUnavailable();
      }
      return yield* Effect.tryPromise(() =>
        readHostedProgress({
          db: env.DB,
          subject: {
            userId,
            id: admission.value.sessionId,
            digest: new Uint8Array(admission.value.digest),
          },
          turnId: admission.value.turnId,
          scheduleRecovery: (due) => state.storage.setAlarm(due),
        })
      ).pipe(Effect.orElseSucceed(transactionUnavailable));
    })
  );
};

const executeHostedMutation = (
  owner: AgentServiceInput,
  {
    admission,
    operation,
    input,
    hostedFence,
  }: Readonly<{
    admission: typeof HostedTurnAdmission.Type;
    operation: CanonicalOperationId;
    input: CanonicalToolEvidence;
    hostedFence: HostedCommitFence;
  }>
): Promise<Response> => {
  const env = owner.environment;
  const batch = Schema.decodeUnknownOption(
    Schema.Struct({ payload: Schema.Struct({ calls: BatchCalls }) })
  )(input);
  if (operation === atomicBatchOperation && Option.isNone(batch)) {
    return Promise.resolve(transactionUnavailable());
  }
  const work: CanonicalWork =
    operation === atomicBatchOperation && Option.isSome(batch)
      ? { _tag: "Batch", calls: batch.value.payload.calls }
      : { _tag: "Call", operation, input };
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const inference = canonicalWorkRequiresInference(work)
          ? yield* optionalHostedInference({
              environment: env,
              db: env.DB,
              userId: admission.userId,
              admittedTurnId: () => Option.some(hostedFence.turnId),
            })
          : Option.none();
        return yield* executeCanonicalWork({
          db: env.DB,
          work,
          subject: {
            userId: admission.userId,
            id: admission.sessionId,
            digest: new Uint8Array(admission.digest),
          },
          current: transactionNow(),
          bucket: Option.fromUndefinedOr(env.STATEMENT_STAGING_BUCKET),
          hostedFence: Option.some(hostedFence),
          inference,
        });
      })
    )
  );
};

const runWhatsAppStatus = (owner: AgentServiceInput, request: Request): Promise<Response> => {
  const userId = owner.userId;
  const env = owner.environment;
  return Effect.runPromise(
    Effect.gen(function* () {
      const candidate = yield* Effect.tryPromise(() => request.json()).pipe(
        Effect.orElseSucceed(() => undefined)
      );
      const admission = Schema.decodeUnknownOption(StatusAdmission)(candidate);
      if (Option.isNone(admission) || admission.value.userId !== userId) {
        return transactionUnavailable();
      }
      const reconciled = yield* reconcileWhatsAppStatus({ db: env.DB, admission: admission.value });
      if (reconciled._tag === "Refused") return transactionUnavailable();
      if (reconciled._tag === "TerminalEvidence") {
        yield* finishHostedTurn({ db: env.DB, ...reconciled.completion });
      }
      return new Response(null, { status: 200 });
    }).pipe(
      Effect.withSpan("agent.whatsappTurn.status"),
      Effect.orElseSucceed(transactionUnavailable)
    )
  );
};

const runHostedRequest = (
  owner: AgentServiceInput,
  request: Request,
  { path, deadline }: Readonly<{ path: string; deadline: ReturnType<typeof hostedDeadline> }>
): Promise<Response> => {
  if (path === "/hosted-turn/whatsapp/work") {
    return runWhatsAppWork(owner, request, deadline);
  }
  if (path === "/hosted-turn/whatsapp") {
    return runWhatsAppTurn(owner, request, deadline);
  }
  return runHostedTurn(owner, request, deadline);
};

const runWhatsAppWork = (
  owner: AgentServiceInput,
  request: Request,
  deadline: ReturnType<typeof hostedDeadline>
): Promise<Response> => {
  const userId = owner.userId;
  const env = owner.environment;
  const state = { storage: { setAlarm: owner.scheduleRecovery } };
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const candidate = yield* Effect.tryPromise(() => request.json()).pipe(
          Effect.orElseSucceed(() => undefined)
        );
        const work = Schema.decodeUnknownOption(WhatsAppWork)(candidate);
        if (Option.isNone(work) || work.value.userId !== userId) return transactionUnavailable();
        const prepared = yield* prepareWhatsAppExecution(env, userId, () =>
          Option.some(work.value.turnId)
        );
        if (Option.isNone(prepared)) return transactionUnavailable();
        return yield* Effect.tryPromise(() =>
          resumeWhatsAppTurn({
            db: env.DB,
            userId: UserId.make(userId),
            turnId: work.value.turnId,
            inference: prepared.value.inference,
            signal: deadline.signal,
            scheduleRecovery: (dueAtMs) => state.storage.setAlarm(dueAtMs),
            deliver: (admission) => ({
              _tag: "WhatsApp",
              send: ({ text, correlationToken }) =>
                sendWhatsAppAttempt({
                  sender: prepared.value.sender,
                  admission,
                  text,
                  correlationToken,
                }),
            }),
          })
        );
      }).pipe(
        Effect.provideService(
          FetchHttpClient.Fetch,
          observeProviderFetch(globalThis.fetch, {
            provider: "kapso",
            environment: env,
            telemetry: cloudflareWorkerTelemetry,
          })
        ),
        Effect.withSpan("agent.whatsappTurn.resume"),
        Effect.catchCause(() => Effect.succeed(transactionUnavailable()))
      )
    )
  );
};

const runWhatsAppTurn = (
  owner: AgentServiceInput,
  request: Request,
  deadline: ReturnType<typeof hostedDeadline>
): Promise<Response> => {
  const userId = owner.userId;
  const env = owner.environment;
  const state = { storage: { setAlarm: owner.scheduleRecovery } };
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const candidate = yield* Effect.tryPromise(() => request.json()).pipe(
          Effect.orElseSucceed(() => undefined)
        );
        const admission = Schema.decodeUnknownOption(TurnAdmission)(candidate);
        if (Option.isNone(admission) || admission.value.userId !== userId) {
          return transactionUnavailable();
        }
        const proof = admission.value;
        const replay = yield* classifyWhatsAppAdmission({
          db: env.DB,
          proof,
          now: transactionNow(),
        });
        if (replay !== "fresh") {
          const status = { expired: 422, replay: 200, conflict: 409 }[replay];
          return new Response(null, { status });
        }
        const prepared = yield* prepareWhatsAppExecution(env, userId, deadline.admittedTurnId);
        if (Option.isNone(prepared)) return transactionUnavailable();
        return yield* Effect.tryPromise(() =>
          startWhatsAppTurn({
            db: env.DB,
            proof,
            inference: prepared.value.inference,
            sender: prepared.value.sender,
            signal: deadline.signal,
            scheduleRecovery: (dueAtMs) => state.storage.setAlarm(dueAtMs),
            onAdmitted: deadline.onAdmitted,
          })
        );
      }).pipe(
        Effect.provideService(
          FetchHttpClient.Fetch,
          observeProviderFetch(globalThis.fetch, {
            provider: "kapso",
            environment: env,
            telemetry: cloudflareWorkerTelemetry,
          })
        ),
        Effect.withSpan("agent.whatsappTurn.execution"),
        Effect.orElseSucceed(transactionUnavailable)
      )
    )
  );
};

const runHostedTurn = (
  owner: AgentServiceInput,
  request: Request,
  deadline: ReturnType<typeof hostedDeadline>
): Promise<Response> => {
  const userId = owner.userId;
  const env = owner.environment;
  const state = { storage: { setAlarm: owner.scheduleRecovery } };
  const executeMutation = (input: Parameters<typeof executeHostedMutation>[1]): Promise<Response> =>
    executeHostedMutation(owner, input);
  return Effect.runPromise(
    Effect.gen(function* () {
      const candidate = yield* Effect.tryPromise(() => request.json()).pipe(
        Effect.orElseSucceed(() => undefined)
      );
      const admission = Schema.decodeUnknownOption(HostedTurnAdmission)(candidate);
      if (
        Option.isNone(admission) ||
        admission.value.userId !== userId ||
        admission.value.digest.length !== digestBytes
      ) {
        return transactionUnavailable();
      }
      const inference = yield* Effect.exit(
        makeUserCloudflareHostedInference({
          environment: env,
          db: env.DB,
          userId,
          admittedTurnId: deadline.admittedTurnId,
        })
      );
      if (Exit.isFailure(inference)) return transactionUnavailable();
      return yield* Effect.tryPromise(() =>
        completeHostedTurnWithAdmission({
          input: {
            db: env.DB,
            bucket: Option.fromUndefinedOr(env.STATEMENT_STAGING_BUCKET),
            executeMutation: Option.some((operation, input, hostedFence) =>
              executeMutation({ admission: admission.value, operation, input, hostedFence })
            ),
            subject: {
              userId: admission.value.userId,
              id: admission.value.sessionId,
              digest: new Uint8Array(admission.value.digest),
            },
            text: admission.value.text,
            inference: inference.value,
            deliver: browserHostedDelivery,
            signal: deadline.signal,
            scheduleRecovery: (dueAtMs) => state.storage.setAlarm(dueAtMs),
          },
          onAdmitted: deadline.onAdmitted,
        })
      ).pipe(
        Effect.withSpan("agent.hostedTurn.execution"),
        Effect.orElseSucceed(transactionUnavailable)
      );
    })
  );
};
const acceptHostedRequest = (
  owner: AgentServiceInput,
  { request, preceding }: Parameters<AgentService["accept"]>[0]
): ReturnType<AgentService["accept"]> => {
  const path = new URL(request.url).pathname;
  if (path === "/hosted-turn/progress") {
    return Option.some({
      response: runHostedProgress(owner, request).catch(transactionUnavailable),
      settled: preceding,
    });
  }
  const executes =
    path === "/hosted-turn" ||
    path === "/hosted-turn/whatsapp" ||
    path === "/hosted-turn/whatsapp/work";
  if (!executes && path !== "/hosted-turn/receipt" && path !== "/hosted-turn/whatsapp/status") {
    return Option.none();
  }
  const deadline = executes
    ? Option.some(hostedDeadline(request.signal))
    : Option.none<ReturnType<typeof hostedDeadline>>();
  const response = preceding
    .then(() =>
      Option.match(deadline, {
        onSome: (deadline) => runHostedRequest(owner, request, { path, deadline }),
        onNone: () =>
          path === "/hosted-turn/receipt"
            ? runHostedReceipt(owner, request)
            : runWhatsAppStatus(owner, request),
      })
    )
    .catch(transactionUnavailable);
  const ownerSettled = response.then(
    () => undefined,
    () => undefined
  );
  return Option.some({
    response: Option.match(deadline, {
      onNone: () => response,
      onSome: (soft) => Promise.race([response, soft.processing]).finally(soft.cancel),
    }),
    settled: Option.match(deadline, {
      onNone: () => ownerSettled,
      onSome: () =>
        boundedHostedOwner({ ownerSettled, recover: () => recoverAbandonedWork(owner) }),
    }),
  });
};

/** Construct only the existing hosted workflow; the caller retains its shared User queue. */
export const makeHostedService = (owner: AgentServiceInput): AgentService => ({
  recover: () => recoverAbandonedWork(owner),
  accept: (input) => acceptHostedRequest(owner, input),
});
