import {
  type CanonicalToolEvidence,
  type TranscriptText,
  type TranscriptTurnId,
  UserId,
} from "@fidy/server/agent-runtime";
import {
  CanonicalCapability,
  CanonicalOperationId,
  atomicBatchOperation,
  maximumAtomicBatchCalls,
  operationCatalog,
} from "@fidy/server/canonical-runtime";
import { memoryOperationIds } from "@fidy/server/memory-api";
import { HostedInference, type HostedInferenceService } from "@fidy/server/hosted-inference";
import { makeHostedSender } from "@fidy/server/whatsapp-runtime";
import {
  Cause,
  Context,
  Data,
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
} from "../../src/shell/channels/whatsapp/contract";
import {
  HostedDeliveryAdmission,
  HostedProgressAdmission,
  HostedTurnAdmission,
  acknowledgeBrowserTurn,
  browserHostedDelivery,
  completeHostedTurnWithAdmission,
  completeWhatsAppTurnWithAdmission,
  readHostedProgress,
  resumeWhatsAppTurn,
} from "../agent/hosted-turn";
import {
  expireHostedPending,
  finishHostedTurn,
  pendingExecutionRecoveryMs,
} from "../agent/turn-store";
import {
  type WorkersAiEnvironment,
  cloudflareHostedInferenceLive,
  makeUserCloudflareHostedInference,
} from "../ai/workers-ai";
import {
  type TransactionCaller,
  transactionNow,
  transactionUnavailable,
} from "../canonical-work/operations";
import { ForwardedEmailWork, StatementCoordinatorActivity } from "../ingestion/contract";
import {
  failStatementSubmission,
  processForwardedEmail,
  processStatementSubmission,
  unavailableStatement,
} from "../ingestion/operations";
import {
  executeCanonicalBatch,
  executeHostedCanonicalBatch,
  rawOperation,
} from "../mutations/canonical-mutation-batch";
import {
  type CanonicalMutationAdapter,
  canonicalMutationAdapter,
} from "../mutations/canonical-mutation-registry";
import {
  type HostedCommitFence,
  executeSingleCanonicalMutation,
} from "../mutations/canonical-mutation-unit";
import { type CanonicalMutationPreparation, refusedPreparation } from "../mutations/mutation-types";
import { coordinatorProbeName } from "../runtime/operational-probes";
import {
  cloudflareWorkerTelemetry,
  observeProviderFetch,
  observeWorkerPromise,
  observeWorkerResponse,
  workerRelease,
} from "../runtime/telemetry";

import { evaluateBudgetAlerts } from "../budgets/operations";
import {
  WhatsAppStatusAdmission as StatusAdmission,
  WhatsAppTurnAdmission as TurnAdmission,
  WhatsAppHostedSubject,
  type WhatsAppTurnAdmission,
  WhatsAppUnavailable,
  WhatsAppWork,
} from "../whatsapp/contract";
import { classifyWhatsAppAdmission, reconcileWhatsAppStatus } from "../whatsapp/operations";

const digestBytes = 32;
const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
class StatementActivityUnavailable extends Data.TaggedError("StatementActivityUnavailable")<{
  cause: unknown;
}> {}
class EmailActivityUnavailable extends Data.TaggedError("EmailActivityUnavailable") {}
const httpServiceUnavailable = 503;
const Credentials = {
  userId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
} as const;
const WebSession = { ...Credentials, sessionId: Schema.String.check(Schema.isUUID()) } as const;
const PAT = {
  ...Credentials,
  patId: Schema.String.check(Schema.isUUID()),
  requiredScope: Schema.NullOr(CanonicalCapability),
} as const;
/**
 * The bounded raw child list a Batch work payload carries. Each entry stays `Unknown` here because the
 * batch adapter decodes it against the published catalog call union, where a malformed child can
 * still be attributed and audited as the child it named.
 */
export const BatchCalls = Schema.NonEmptyArray(Schema.Unknown).check(
  Schema.isMaxLength(maximumAtomicBatchCalls)
);
export type BatchCalls = typeof BatchCalls.Type;
const Batch = { calls: BatchCalls } as const;
/**
 * One canonical call an individual work payload carries: the operation id the catalog publishes and the
 * raw canonical input its owner adapter decodes. The operation id alone selects the owner adapter,
 * so a new composable mutation joins this dispatcher without editing it.
 */
const Call = {
  operation: CanonicalOperationId,
  input: Schema.Unknown,
} as const;

/**
 * Every piece of composable canonical work one User coordinator executes. A Call carries one
 * catalog mutation's canonical input; a Batch carries the bounded raw child list the batch adapter
 * decodes per child. Each owner adapter rechecks live authority and domain state before the shared
 * D1 unit commits anything.
 */
export const CanonicalWork = Schema.Union([
  Schema.TaggedStruct("Call", Call),
  Schema.TaggedStruct("Batch", Batch),
]);
export type CanonicalWork = typeof CanonicalWork.Type;

/** The atomic batch request envelope: the bounded raw child list the adapter decodes per child. */
export const BatchInput = Schema.Struct(Batch);
export type BatchInput = typeof BatchInput.Type;

/**
 * One work admission: the live subject authority plus the exact work it admits. It is not
 * itself a canonical mutation — the mutation travels inside `work` — so it is named for what it
 * does rather than for the thing it carries.
 */
export const CanonicalWorkAdmission = Schema.Union([
  Schema.TaggedStruct("WebSessionWork", { ...WebSession, work: CanonicalWork }),
  Schema.TaggedStruct("PATWork", { ...PAT, work: CanonicalWork }),
]);
export type CanonicalWorkAdmission = typeof CanonicalWorkAdmission.Type;

/**
 * The live WebSession facts an admission carries for one piece of work: the session id, its
 * User, and the proof digest the coordinator re-verifies against live authority before any D1 unit
 * commits. The work itself is excluded — it is what the authority admits, not part of it.
 */
type WebSessionAuthority = Omit<
  Extract<CanonicalWorkAdmission, { _tag: "WebSessionWork" }>,
  "_tag" | "work"
>;
/**
 * The live PAT facts an admission carries for one piece of work: the PAT id, its User, the
 * proof digest, and the required capability the coordinator re-verifies against live authority
 * before any D1 unit commits. The work itself is excluded — it is what the authority admits.
 */
type PATAuthority = Omit<Extract<CanonicalWorkAdmission, { _tag: "PATWork" }>, "_tag" | "work">;
export type { PATAuthority, WebSessionAuthority };

/** Rebuild the exact live subject the work admission was issued for. */
const admissionSubject = (admission: CanonicalWorkAdmission): TransactionCaller =>
  admission._tag === "PATWork"
    ? {
        patId: admission.patId,
        userId: admission.userId,
        digest: new Uint8Array(admission.digest),
        requiredScope: Option.fromNullishOr(admission.requiredScope),
      }
    : {
        id: admission.sessionId,
        userId: admission.userId,
        digest: new Uint8Array(admission.digest),
      };

type WorkInput = Readonly<{
  db: D1Database;
  bucket: Option.Option<R2Bucket>;
  work: CanonicalWork;
  subject: TransactionCaller;
  current: number;
  hostedFence: Option.Option<HostedCommitFence>;
}>;

/** Reprepare only the statement whose identical material won a concurrent publication race. */
const retryStatementPreparation = (
  adapter: CanonicalMutationAdapter,
  input: Parameters<CanonicalMutationAdapter["prepare"]>[0]
): Effect.Effect<CanonicalMutationPreparation> =>
  adapter.prepare(input).pipe(Effect.provideService(HostedInference, unreachableHostedInference));

/** Execute one catalog call through its owner adapter and the shared mutation unit. */
const executeCall = ({
  db,
  work,
  subject,
  current,
  bucket,
  hostedFence,
}: WorkInput & Readonly<{ work: Extract<CanonicalWork, { _tag: "Call" }> }>): Effect.Effect<
  Response,
  never,
  HostedInference
> =>
  Effect.gen(function* () {
    const adapter = canonicalMutationAdapter(work.operation);
    if (Option.isNone(adapter)) return transactionUnavailable();
    const catalogOperation = operationCatalog.byId.get(work.operation);
    if (catalogOperation === undefined) return transactionUnavailable();
    const input = Schema.decodeUnknownOption(catalogOperation.input)(work.input);
    if (Option.isNone(input)) {
      // The call cannot be decoded against the operation it names, so the owner adapter answers for
      // it under its own input classification and no write is attempted.
      return yield* executeSingleCanonicalMutation({
        db,
        subject,
        current,
        preparation: refusedPreparation(
          adapter.value.invalidRefusal({ db, subject, current, input: work.input, bucket })
        ),
        present: adapter.value.present,
        retryStatement: Option.none(),
        hostedFence,
      });
    }
    const ownerWork = { db, subject, current, input: input.value, bucket };
    const preparation = yield* adapter.value.prepare(ownerWork);
    const retryStatement = (): Effect.Effect<CanonicalMutationPreparation> =>
      retryStatementPreparation(adapter.value, ownerWork);
    const response = yield* executeSingleCanonicalMutation({
      db,
      subject,
      current,
      preparation,
      present: adapter.value.present,
      retryStatement:
        work.operation === "ingestion.submitForExtraction"
          ? Option.some(retryStatement)
          : Option.none(),
      hostedFence,
    });
    return work.operation === "ingestion.submitForExtraction" &&
      response.status === httpServiceUnavailable
      ? unavailableStatement()
      : response;
  });

/** Dispatch a bounded batch or an individual catalog call within one User coordination turn. */
const affectsBudget = (operation: CanonicalOperationId): boolean =>
  operation.startsWith("budgets.") || operation.startsWith("transactions.");

const executeWork = (input: WorkInput): Effect.Effect<Response, never, HostedInference> =>
  Effect.gen(function* () {
    const budgetWork =
      input.work._tag === "Call"
        ? affectsBudget(input.work.operation)
        : input.work.calls.some((child) => Option.exists(rawOperation(child), affectsBudget));
    // Drain committed work before a later correction can lower spending below a reached mark.
    if (
      budgetWork &&
      !(yield* evaluateBudgetAlerts({ db: input.db, userId: input.subject.userId }))
    ) {
      return transactionUnavailable();
    }
    const work = input.work;
    const result = yield* work._tag === "Batch"
      ? Option.match(input.hostedFence, {
          onNone: () =>
            executeCanonicalBatch({
              db: input.db,
              subject: input.subject,
              calls: work.calls,
              current: input.current,
              bucket: input.bucket,
            }),
          onSome: (hostedFence) =>
            executeHostedCanonicalBatch({
              db: input.db,
              subject: input.subject,
              calls: work.calls,
              current: input.current,
              bucket: input.bucket,
              hostedFence,
            }),
        })
      : executeCall({ ...input, work });
    if (result.ok && budgetWork) {
      // Atomic D1 triggers retain versioned work even when this best-effort drain is interrupted.
      yield* evaluateBudgetAlerts({ db: input.db, userId: input.subject.userId });
    }
    return result;
  });

/** True for an operation id the Memory group declares, so a new one needs no second derivation. */
const isMemoryOperation = (operation: CanonicalOperationId): boolean =>
  memoryOperationIds.some((declared) => declared === operation);

/**
 * True when the work can reach the Memory capacity policy, the only consumer of hosted
 * inference. Every other owner decides without it, so a missing AI binding must not deny
 * their work.
 */
const requiresHostedInference = (work: CanonicalWork): boolean => {
  if (work._tag === "Batch") {
    return work.calls.some((call) => Option.exists(rawOperation(call), isMemoryOperation));
  }
  return isMemoryOperation(work.operation);
};

/**
 * The coordination authority's dependencies: the D1 database it commits through, plus the hosted
 * inference bindings the Memory owner's capacity policy needs. Only Memory work reads them, so an
 * unusable binding denies that owner alone and every other owner decides without it.
 */
type CoordinatorEnvironment = Readonly<{
  DB: D1Database;
}> &
  /** Native optional binding, normalized to Option when work enters the application. */
  Partial<
    Readonly<{ STATEMENT_STAGING_BUCKET: R2Bucket; EMAIL_BUCKET: R2Bucket; KAPSO_API_KEY: string }>
  > &
  WorkersAiEnvironment;

/**
 * The hosted-inference service one Memory workload runs under, or None when the deployment's
 * binding or model cannot provide it. The layer is built only for work that consumes it, so a
 * missing or unsupported configuration never reaches the owners that decide without it.
 */
const hostedInferenceFor = (
  environment: CoordinatorEnvironment,
  userId: string,
  admittedTurnId: Option.Option<TranscriptTurnId>
): Effect.Effect<Option.Option<HostedInferenceService>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const built = yield* Effect.exit(
      Layer.build(
        cloudflareHostedInferenceLive({
          environment,
          db: environment.DB,
          userId,
          admittedTurnId: () => admittedTurnId,
        })
      )
    );
    return Exit.isFailure(built)
      ? Option.none()
      : Option.some(Context.get(built.value, HostedInference));
  });

/**
 * The hosted-inference service non-Memory work runs under: every method dies. Only the Memory
 * capacity policy consumes hosted inference, and it provisions the real service itself, so a
 * consumer appearing anywhere else fails closed instead of deciding without inference.
 */
const unreachableHostedInference = HostedInference.of({
  countText: () => Effect.die("Hosted inference reached without Memory work"),
  countTranscript: () => Effect.die("Hosted inference reached without Memory work"),
  prepareText: () => Effect.die("Hosted inference reached without Memory work"),
  validateText: () => Effect.die("Hosted inference reached without Memory work"),
  prepareStructured: () => Effect.die("Hosted inference reached without Memory work"),
});

const executeStatementActivity = (
  activity: typeof StatementCoordinatorActivity.Type,
  environment: CoordinatorEnvironment,
  userId: string
): Effect.Effect<Response> => {
  const { submissionId } = activity;
  const request =
    activity._tag === "StatementFailed"
      ? (): Promise<number> =>
          failStatementSubmission({
            DB: environment.DB,
            userId,
            submissionId,
            // The Workflow's bounded retry budget is exhausted; preserve partial outcomes.
            reason: "resource-limit",
          }).then(() => HTTP_OK)
      : (): Promise<number> => {
          const bucket = environment.STATEMENT_STAGING_BUCKET;
          if (bucket === undefined) return Promise.resolve(httpServiceUnavailable);
          return processStatementSubmission({
            DB: environment.DB,
            STATEMENT_STAGING_BUCKET: bucket,
            userId,
            submissionId,
          }).then((progress) => (progress === "continue" ? HTTP_ACCEPTED : HTTP_OK));
        };
  return Effect.tryPromise({
    try: request,
    catch: (cause) => new StatementActivityUnavailable({ cause }),
  }).pipe(
    Effect.map((status) => new Response(null, { status })),
    Effect.orElseSucceed(transactionUnavailable)
  );
};

const authorizedStatementActivity = (
  candidate: unknown,
  userId: string
): Option.Option<typeof StatementCoordinatorActivity.Type> =>
  Schema.decodeUnknownOption(StatementCoordinatorActivity)(candidate).pipe(
    Option.filter((activity) => activity.userId === userId)
  );

const executeCanonicalAdmission = (
  admission: CanonicalWorkAdmission,
  environment: CoordinatorEnvironment,
  hostedFence: Option.Option<HostedCommitFence>
): Effect.Effect<Response, never, Scope.Scope> =>
  Effect.gen(function* () {
    const work = admission.work;
    const execution = executeWork({
      db: environment.DB,
      work,
      subject: admissionSubject(admission),
      current: transactionNow(),
      bucket: Option.fromUndefinedOr(environment.STATEMENT_STAGING_BUCKET),
      hostedFence,
    });
    if (!requiresHostedInference(work)) {
      return yield* execution.pipe(
        Effect.provideService(HostedInference, unreachableHostedInference)
      );
    }
    const inference = yield* hostedInferenceFor(
      environment,
      admission.userId,
      Option.map(hostedFence, ({ turnId }) => turnId)
    );
    if (Option.isNone(inference)) return transactionUnavailable();
    return yield* execution.pipe(Effect.provideService(HostedInference, inference.value));
  });

const executeForwardedEmailActivity = (
  candidate: unknown,
  environment: CoordinatorEnvironment,
  userId: string
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const work = Schema.decodeUnknownOption(ForwardedEmailWork)(candidate);
    const bucket = environment.EMAIL_BUCKET;
    if (Option.isNone(work) || work.value.userId !== userId || bucket === undefined) {
      return transactionUnavailable();
    }
    const completed = yield* Effect.exit(
      Effect.tryPromise({
        try: () =>
          processForwardedEmail({
            DB: environment.DB,
            EMAIL_BUCKET: { get: (key) => bucket.get(key).then(Option.fromNullishOr) },
            userId,
            receiptId: work.value.receiptId,
          }),
        catch: () => new EmailActivityUnavailable(),
      }).pipe(Effect.withSpan("ingestion.forwarded-email.process"))
    );
    return Exit.isFailure(completed)
      ? transactionUnavailable()
      : new Response(null, { status: HTTP_OK });
  });

const privateIngestionActivity = ({
  request,
  candidate,
  environment,
  userId,
}: Readonly<{
  request: Request;
  candidate: unknown;
  environment: CoordinatorEnvironment;
  userId: string;
}>): Option.Option<Effect.Effect<Response>> => {
  if (request.method !== "POST") return Option.none();
  const path = new URL(request.url).pathname;
  if (path === "/forwarded-email-work") {
    return Option.some(executeForwardedEmailActivity(candidate, environment, userId));
  }
  if (path !== "/statement-work") return Option.none();
  const activity = authorizedStatementActivity(candidate, userId);
  return Option.some(
    Option.isNone(activity)
      ? Effect.succeed(transactionUnavailable())
      : executeStatementActivity(activity.value, environment, userId)
  );
};

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
  environment: CoordinatorEnvironment,
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

const reservedCoordinatorProbe = ({
  db,
  userId,
  path,
  method,
}: Readonly<{
  db: D1Database;
  userId: string;
  path: string;
  method: string;
}>): Option.Option<Promise<Response>> => {
  if (path === "/operational/probe" && userId === coordinatorProbeName) {
    return Option.some(
      db
        .prepare("SELECT 1 AS usable")
        .first()
        .then(
          () => new Response(null, { status: 204 }),
          () => new Response(null, { status: 503 })
        )
    );
  }
  // Reserved smoke compatibility never enters User coordination or reads D1.
  if (userId !== "_release-smoke-v1") return Option.none();
  return Option.some(
    Promise.resolve(
      path === "/release-smoke" && method === "GET"
        ? Response.json({ status: "compatible" })
        : Response.json({}, { status: 404 })
    )
  );
};

/** One instance per stable User coordinates mutations; D1 alone owns the FinancialRecord. */
export class UserTransactionCoordinator {
  private pending: Promise<void> = Promise.resolve();
  private readonly state: Readonly<{
    id: Readonly<{ name: string }>;
    storage: Pick<DurableObjectStorage, "setAlarm">;
  }>;
  private readonly env: CoordinatorEnvironment;
  constructor(
    state: Readonly<{
      id: Readonly<{ name: string }>;
      storage: Pick<DurableObjectStorage, "setAlarm">;
    }>,
    env: CoordinatorEnvironment
  ) {
    this.state = state;
    this.env = env;
  }

  fetch(request: Request): Promise<Response> {
    const environment = this.env;
    const userId = this.state.id.name;
    const path = new URL(request.url).pathname;
    const probe = reservedCoordinatorProbe({
      db: environment.DB,
      userId,
      path,
      method: request.method,
    });
    if (Option.isSome(probe)) return probe.value;
    // A progress read has live session authority but does not start canonical work.
    if (path === "/hosted-turn/progress") {
      return observeWorkerResponse(() => this.runHostedProgress(request, userId), {
        environment: workerRelease(environment),
        telemetry: cloudflareWorkerTelemetry,
        operation: "worker.core.coordinator",
      });
    }
    const deadline =
      path === "/hosted-turn" ||
      path === "/hosted-turn/whatsapp" ||
      path === "/hosted-turn/whatsapp/work"
        ? Option.some(hostedDeadline(request.signal))
        : Option.none<ReturnType<typeof hostedDeadline>>();
    const prior = this.pending;
    const settledResponse = observeWorkerResponse(
      () => prior.then(() => this.runCoordinatedRequest({ request, userId, path, deadline })),
      {
        environment: workerRelease(environment),
        telemetry: cloudflareWorkerTelemetry,
        operation: "worker.core.coordinator",
      }
    );
    const ownerSettled = settledResponse.then(
      () => undefined,
      () => undefined
    );
    this.pending = Option.match(deadline, {
      onNone: () => ownerSettled,
      onSome: () =>
        boundedHostedOwner({ ownerSettled, recover: () => this.recoverAbandonedWork() }),
    });
    return Option.match(deadline, {
      onNone: () => settledResponse,
      onSome: (soft) => Promise.race([settledResponse, soft.processing]).finally(soft.cancel),
    });
  }

  private runCoordinatedRequest(
    input: Readonly<{
      request: Request;
      userId: string;
      path: string;
      deadline: Option.Option<ReturnType<typeof hostedDeadline>>;
    }>
  ): Promise<Response> {
    const { request, userId, path, deadline } = input;
    if (Option.isSome(deadline)) {
      return this.runHostedRequest(request, userId, { path, deadline: deadline.value });
    }
    if (path === "/hosted-turn/whatsapp/status") return this.runWhatsAppStatus(request, userId);
    if (path === "/hosted-turn/receipt") return this.runHostedReceipt(request, userId);
    const environment = this.env;
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const candidate = yield* Effect.option(Effect.tryPromise(() => request.json()));
          if (Option.isNone(candidate)) return transactionUnavailable();
          const ingestion = privateIngestionActivity({
            request,
            candidate: candidate.value,
            environment,
            userId,
          });
          if (Option.isSome(ingestion)) return yield* ingestion.value;
          const admission = Schema.decodeUnknownOption(CanonicalWorkAdmission)(candidate.value);
          if (
            Option.isNone(admission) ||
            admission.value.digest.length !== digestBytes ||
            admission.value.userId !== userId
          ) {
            return transactionUnavailable();
          }
          return yield* executeCanonicalAdmission(admission.value, environment, Option.none());
        })
      )
    );
  }

  /** Durable alarm recovers abandoned work even when its User never submits another Turn. */
  alarm(): Promise<void> {
    const action = this.pending.then(() => this.recoverAbandonedWork());
    this.pending = action.then(
      () => undefined,
      () => undefined
    );
    return observeWorkerPromise(() => action, {
      environment: workerRelease(this.env),
      telemetry: cloudflareWorkerTelemetry,
      operation: "worker.core.alarm",
    });
  }

  private recoverAbandonedWork(): Promise<void> {
    const { env, state } = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        const next = yield* expireHostedPending({
          db: env.DB,
          userId: UserId.make(state.id.name),
          now: transactionNow(),
        });
        if (Option.isSome(next)) {
          yield* Effect.tryPromise(() => state.storage.setAlarm(next.value));
        }
      })
    );
  }

  private runHostedReceipt(request: Request, userId: string): Promise<Response> {
    const { env } = this;
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
  }

  private runHostedProgress(request: Request, userId: string): Promise<Response> {
    const { env, state } = this;
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
  }

  private executeHostedMutation({
    admission,
    operation,
    input,
    hostedFence,
  }: Readonly<{
    admission: typeof HostedTurnAdmission.Type;
    operation: CanonicalOperationId;
    input: CanonicalToolEvidence;
    hostedFence: HostedCommitFence;
  }>): Promise<Response> {
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
        executeCanonicalAdmission(
          {
            _tag: "WebSessionWork",
            userId: admission.userId,
            sessionId: admission.sessionId,
            digest: admission.digest,
            work,
          },
          this.env,
          Option.some(hostedFence)
        )
      )
    );
  }

  private runWhatsAppStatus(request: Request, userId: string): Promise<Response> {
    const { env } = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        const candidate = yield* Effect.tryPromise(() => request.json()).pipe(
          Effect.orElseSucceed(() => undefined)
        );
        const admission = Schema.decodeUnknownOption(StatusAdmission)(candidate);
        if (Option.isNone(admission) || admission.value.userId !== userId) {
          return transactionUnavailable();
        }
        const accepted = yield* reconcileWhatsAppStatus({
          db: env.DB,
          admission: admission.value,
          completeTurn: (completion) =>
            finishHostedTurn({ db: env.DB, ...completion }).pipe(
              Effect.mapError(() => new WhatsAppUnavailable())
            ),
        });
        return accepted ? new Response(null, { status: 200 }) : transactionUnavailable();
      }).pipe(
        Effect.withSpan("agent.whatsappTurn.status"),
        Effect.orElseSucceed(transactionUnavailable)
      )
    );
  }

  private runHostedRequest(
    request: Request,
    userId: string,
    { path, deadline }: Readonly<{ path: string; deadline: ReturnType<typeof hostedDeadline> }>
  ): Promise<Response> {
    if (path === "/hosted-turn/whatsapp/work") {
      return this.runWhatsAppWork(request, userId, deadline);
    }
    if (path === "/hosted-turn/whatsapp") {
      return this.runWhatsAppTurn(request, userId, deadline);
    }
    return this.runHostedTurn(request, userId, deadline);
  }

  private runWhatsAppWork(
    request: Request,
    userId: string,
    deadline: ReturnType<typeof hostedDeadline>
  ): Promise<Response> {
    const { env, state } = this;
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
  }

  private runWhatsAppTurn(
    request: Request,
    userId: string,
    deadline: ReturnType<typeof hostedDeadline>
  ): Promise<Response> {
    const { env, state } = this;
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
  }

  private runHostedTurn(
    request: Request,
    userId: string,
    deadline: ReturnType<typeof hostedDeadline>
  ): Promise<Response> {
    const { env, state } = this;
    const executeMutation = this.executeHostedMutation.bind(this);
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
  }
}
