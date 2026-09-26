import { HostedInference, type HostedInferenceService } from "@fidy/server/hosted-inference";
import {
  HostedTurnAdmission,
  browserHostedDelivery,
  completeHostedTurn,
} from "../agent/hosted-turn";
import {
  CanonicalCapability,
  CanonicalOperationId,
  maximumAtomicBatchCalls,
  operationCatalog,
} from "@fidy/server/canonical-runtime";
import { memoryOperationIds } from "@fidy/server/memory-runtime";
<<<<<<< HEAD
import { Context, Data, Effect, Exit, Layer, Option, Schema, type Scope } from "effect";
import { type WorkersAiEnvironment, cloudflareHostedInferenceLive } from "../ai/workers-ai";
=======
import { Context, Effect, Exit, Layer, Option, Schema, type Scope } from "effect";
import {
  type WorkersAiEnvironment,
  cloudflareHostedInferenceLive,
  makeCloudflareHostedInference,
} from "../ai/workers-ai";
>>>>>>> 8a6ea92b (feat(agent): #704 complete one hosted Turn on Workers AI)
import { executeCanonicalBatch, rawOperation } from "../mutations/canonical-mutation-batch";
import { unavailableStatement } from "../ingestion/statement-ingestion";
import {
  failStatementSubmission,
  processStatementSubmission,
} from "../ingestion/statement-processing";
import { StatementCoordinatorActivity } from "../ingestion/statement-work";
import { reconcileBudgetLatches } from "../budgets/budget-latches";
import { executeSingleCanonicalMutation } from "../mutations/canonical-mutation-unit";
import {
  type CanonicalMutationAdapter,
  canonicalMutationAdapter,
} from "../mutations/canonical-mutation-registry";
import { type CanonicalMutationPreparation, refusedPreparation } from "../mutations/mutation-types";
import {
  type TransactionCaller,
  transactionNow,
  transactionUnavailable,
} from "./transaction-boundary";

const digestBytes = 32;
const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
class StatementActivityUnavailable extends Data.TaggedError("StatementActivityUnavailable")<{
  cause: unknown;
}> {}
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
export type { WebSessionAuthority, PATAuthority };

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
      !(yield* reconcileBudgetLatches({ db: input.db, userId: input.subject.userId }))
    ) {
      return transactionUnavailable();
    }
    const result =
      input.work._tag === "Batch"
        ? yield* executeCanonicalBatch({
            db: input.db,
            subject: input.subject,
            calls: input.work.calls,
            current: input.current,
            bucket: input.bucket,
          })
        : yield* executeCall({ ...input, work: input.work });
    if (result.ok && budgetWork) {
      // Atomic D1 triggers retain versioned work even when this best-effort drain is interrupted.
      yield* reconcileBudgetLatches({ db: input.db, userId: input.subject.userId });
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
  Partial<Readonly<{ STATEMENT_STAGING_BUCKET: R2Bucket }>> &
  WorkersAiEnvironment;

/**
 * The hosted-inference service one Memory workload runs under, or None when the deployment's
 * binding or model cannot provide it. The layer is built only for work that consumes it, so a
 * missing or unsupported configuration never reaches the owners that decide without it.
 */
const hostedInferenceFor = (
  environment: CoordinatorEnvironment
): Effect.Effect<Option.Option<HostedInferenceService>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const built = yield* Effect.exit(Layer.build(cloudflareHostedInferenceLive(environment)));
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
  environment: CoordinatorEnvironment
): Effect.Effect<Response, never, Scope.Scope> =>
  Effect.gen(function* () {
    const work = admission.work;
    const execution = executeWork({
      db: environment.DB,
      work,
      subject: admissionSubject(admission),
      current: transactionNow(),
      bucket: Option.fromUndefinedOr(environment.STATEMENT_STAGING_BUCKET),
    });
    if (!requiresHostedInference(work)) {
      return yield* execution.pipe(
        Effect.provideService(HostedInference, unreachableHostedInference)
      );
    }
    const inference = yield* hostedInferenceFor(environment);
    if (Option.isNone(inference)) return transactionUnavailable();
    return yield* execution.pipe(Effect.provideService(HostedInference, inference.value));
  });

/** One instance per stable User coordinates mutations; D1 alone owns the FinancialRecord. */
export class UserTransactionCoordinator {
  private pending: Promise<void> = Promise.resolve();
  private readonly state: Readonly<{ id: Readonly<{ name: string }> }>;
  private readonly env: CoordinatorEnvironment;
  constructor(state: Readonly<{ id: Readonly<{ name: string }> }>, env: CoordinatorEnvironment) {
    this.state = state;
    this.env = env;
  }

  fetch(request: Request): Promise<Response> {
    const environment = this.env;
    const userId = this.state.id.name;
    const settledResponse = this.pending.then(() =>
      new URL(request.url).pathname === "/hosted-turn"
        ? this.runHostedTurn(request, userId)
        : Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const candidate = yield* Effect.option(Effect.tryPromise(() => request.json()));
                if (Option.isNone(candidate)) return transactionUnavailable();
                if (request.method === "POST" && new URL(request.url).pathname === "/statement-work") {
                  const activity = authorizedStatementActivity(candidate.value, userId);
                  if (Option.isNone(activity)) return transactionUnavailable();
                  return yield* executeStatementActivity(activity.value, environment, userId);
                }
                const admission = Schema.decodeUnknownOption(CanonicalWorkAdmission)(candidate.value);
                if (
                  Option.isNone(admission) ||
                  admission.value.digest.length !== digestBytes ||
                  admission.value.userId !== userId
                ) {
                  return transactionUnavailable();
                }
                return yield* executeCanonicalAdmission(admission.value, environment);
              })
            )
          )
    );
    this.pending = settledResponse.then(
      () => undefined,
      () => undefined
    );
    return settledResponse;
  }

  // @effect-diagnostics-next-line asyncFunction:off
  private async runHostedTurn(request: Request, userId: string): Promise<Response> {
    const candidate = await request.json().catch(() => undefined);
    const admission = Schema.decodeUnknownOption(HostedTurnAdmission)(candidate);
    if (
      Option.isNone(admission) ||
      admission.value.userId !== userId ||
      admission.value.digest.length !== digestBytes
    ) {
      return transactionUnavailable();
    }
    const inference = await Effect.runPromiseExit(makeCloudflareHostedInference(this.env));
    if (Exit.isFailure(inference)) return transactionUnavailable();
    return completeHostedTurn({
      db: this.env.DB,
      subject: {
        userId: admission.value.userId,
        id: admission.value.sessionId,
        digest: new Uint8Array(admission.value.digest),
      },
      text: admission.value.text,
      inference: inference.value,
      deliver: browserHostedDelivery,
      signal: request.signal,
    }).catch(() => transactionUnavailable());
  }
}
