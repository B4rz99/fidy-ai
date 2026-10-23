import {
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  sanitizeWorkTrace,
  workTraceParent,
  workerRelease,
} from "../../runtime/telemetry/operations";
import { cancelSource } from "./source-cancellation";
import { WompiTransactionId } from "./wompi-model";
import { type WorkflowStepConfig } from "cloudflare:workers";
import { Clock, Effect, Exit, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { type WompiTransportFactory } from "./wompi-runtime";
import {
  BillingCollectionFailure,
  type BillingObservationWorkflow,
  type BillingRuntime,
  SubscriptionCancellationWork,
} from "../contract";

import { reconcileEventCandidate } from "./billing-transaction";

const PreviousLookupWork = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  version: Schema.Literal(1),
  kind: Schema.Literal("lookup"),
  transactionId: WompiTransactionId,
});
const LookupWork = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("lookup"),
  transactionId: WompiTransactionId,
  signedAt: Schema.NullOr(Schema.Finite),
  signedStatus: Schema.NullOr(Schema.String),
});
const CancellationExecution = Schema.Struct({
  ...SubscriptionCancellationWork.fields,
  version: Schema.Literal(2),
});
const Candidate = Schema.Struct({
  transaction_id: WompiTransactionId,
  signed_at: Schema.OptionFromNullOr(Schema.Finite),
  signed_status: Schema.OptionFromNullOr(Schema.String),
});
const pendingBatchSize = 32;
const candidateCooldownMs = 60_000;
const maximumCandidateLookupAttempts = 8;
const eventCandidateLifetimeMs = 86_400_000;

const failure = (cause: Option.Option<unknown> = Option.none()): BillingCollectionFailure =>
  new BillingCollectionFailure({ cause });
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, BillingCollectionFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => failure(Option.some(cause)) });
const decode = <A, E>(
  schema: Schema.Codec<A, E>,
  value: unknown
): Effect.Effect<A, BillingCollectionFailure> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => failure(Option.some(cause)))
  );

const billingWorkflowRetention = {
  successRetention: "3 days",
  errorRetention: "3 days",
} as const;
const terminalStatuses: ReadonlySet<InstanceStatus["status"]> = new Set([
  "errored",
  "terminated",
  "complete",
]);
/** Reserve only new or terminal execution handoffs; an active execution keeps its existing budget. */
const offerBillingWorkflow = (
  input: Readonly<{
    workflow: BillingObservationWorkflow;
    id: string;
    params: unknown;
    reserve: Effect.Effect<boolean, BillingCollectionFailure>;
  }>
): Effect.Effect<boolean, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const existing = yield* Effect.exit(attempt(() => input.workflow.get(input.id)));
    if (Exit.isSuccess(existing)) {
      const current = yield* attempt(() => existing.value.status());
      if (!terminalStatuses.has(current.status)) return true;
    }
    if (!(yield* input.reserve)) return true;
    const started = yield* Effect.exit(
      attempt(() =>
        Exit.isSuccess(existing)
          ? existing.value.restart()
          : input.workflow.create({
              id: input.id,
              params: input.params,
              retention: billingWorkflowRetention,
            })
      )
    );
    if (Exit.isSuccess(started)) return true;
    const recovered = yield* attempt(() => input.workflow.get(input.id));
    const status = yield* attempt(() => recovered.status());
    return status.status === "queued" || status.status === "running" || status.status === "waiting";
  });

/** Offer retained cancellation work; inactive or exhausted intent needs no handoff. Failures leave receipt retryable. */
export const receiveSourceCancellation = (
  input: Readonly<{
    db: D1Database;
    workflow: BillingObservationWorkflow;
    work: typeof SubscriptionCancellationWork.Type;
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const row = yield* attempt(() =>
      input.db
        .prepare(
          "SELECT last_offered_at_ms FROM subscription_cancellation_context WHERE user_id=? AND source_cancellation='void-pending' AND verification_count<8"
        )
        .bind(input.work.userId)
        .first()
    );
    if (row === null) return;
    const params = yield* sanitizeWorkTrace(input.work);
    const offered = yield* offerBillingWorkflow({
      workflow: input.workflow,
      id: `source-cancel-v2-${input.work.userId}`,
      params: { ...params, version: 2 },
      reserve: Effect.succeed(true),
    });
    if (!offered) return yield* new BillingCollectionFailure({ cause: Option.none() });
  });

type ObservationActivity = (
  name: string,
  options: WorkflowStepConfig,
  run: () => Promise<void>
) => Promise<void>;

type BillingObservationExecution = Readonly<{
  environment: BillingRuntime;
  payload: unknown;
  activity: ObservationActivity;
  sleep: (name: string, duration: number) => Promise<void>;
  wompiHttp: WompiTransportFactory;
}>;
type RunActivity = <E>(activity: Effect.Effect<void, E>) => Promise<void>;
/** Execute retained observation work; identities never replace live eligibility or provider evidence. */
export const runBillingObservation = (input: BillingObservationExecution): Promise<void> => {
  const work = Schema.decodeUnknownOption(
    Schema.Union([
      LookupWork,
      PreviousLookupWork,
      SubscriptionCancellationWork,
      CancellationExecution,
    ])
  )(input.payload);
  if (Option.isNone(work)) return Promise.resolve();
  const runActivity = <E>(activity: Effect.Effect<void, E>): Promise<void> =>
    activity.pipe(
      observeWorkerExecution({
        environment: workerRelease(input.environment),
        telemetry: cloudflareWorkerTelemetry,
        operation: "workflow.billingCollection",
        parent: workTraceParent(input.payload),
      }),
      Effect.runPromise
    );
  if (work.value.kind === "source-cancellation") {
    return runCancellationExecution({ input, work: work.value, runActivity });
  }
  if (work.value.version === 2) {
    return runLookupLoop({ input, work: work.value, runActivity });
  }
  const transactionId = work.value.transactionId;
  return input.activity(
    "lookup-wompi-billing-v1",
    { retries: { limit: 0, delay: "1 second" } },
    () =>
      runActivity(
        reconcileEventCandidate({
          environment: input.environment,
          transactionId,
          wompiHttp: input.wompiHttp,
          generation: { signedAt: Option.none(), signedStatus: Option.none() },
        })
      )
  );
};

const runCancellationExecution = ({
  input,
  work,
  runActivity,
}: Readonly<{
  input: BillingObservationExecution;
  work: typeof CancellationExecution.Type | typeof SubscriptionCancellationWork.Type;
  runActivity: RunActivity;
}>): Promise<void> =>
  work.version === 2
    ? runCancellationLoop({ input, work, runActivity })
    : input.activity("cancel-wompi-source-v1", { retries: { limit: 0, delay: "1 second" } }, () =>
        runActivity(
          cancelSource({ environment: input.environment, work, wompiHttp: input.wompiHttp })
        )
      );

const runCancellationLoop = ({
  input,
  work,
  runActivity,
}: Readonly<{
  input: BillingObservationExecution;
  work: typeof CancellationExecution.Type;
  runActivity: RunActivity;
}>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const options = { retries: { limit: 0, delay: "1 second" } } as const;
      for (let index = 0; index < maximumCandidateLookupAttempts; index++) {
        if (index > 0) {
          yield* attempt(() =>
            input.sleep(`source-cancellation-wait-v2-${index}`, candidateCooldownMs + 1)
          );
        }
        yield* attempt(() =>
          input.activity(`cancel-wompi-source-v2-${index}`, options, () =>
            runCancellationCheck({ input, work, runActivity })
          )
        );
      }
    })
  );
const runCancellationCheck = ({
  input,
  work,
  runActivity,
}: Readonly<{
  input: BillingObservationExecution;
  work: typeof CancellationExecution.Type;
  runActivity: RunActivity;
}>): Promise<void> =>
  runActivity(
    cancelSource({ environment: input.environment, work, wompiHttp: input.wompiHttp })
  ).catch(() => undefined);

const observeLookup = (
  input: Readonly<{
    execution: BillingObservationExecution;
    work: typeof LookupWork.Type;
    index: number;
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const { execution, work, index } = input;
    const now = yield* Clock.currentTimeMillis;
    const reserved =
      index === 0
        ? yield* initialLookupReservation(execution.environment.DB, work, now)
        : yield* reserveLookup(execution.environment.DB, work, now);
    if (!reserved) return;
    yield* reconcileEventCandidate({
      environment: execution.environment,
      transactionId: work.transactionId,
      wompiHttp: execution.wompiHttp,
      generation: {
        signedAt: Option.fromNullishOr(work.signedAt),
        signedStatus: Option.fromNullishOr(work.signedStatus),
      },
    });
  });
const runObservedLookup = (
  input: Readonly<{
    execution: BillingObservationExecution;
    work: typeof LookupWork.Type;
    index: number;
    runActivity: RunActivity;
  }>
): Promise<void> => input.runActivity(observeLookup(input)).catch(() => undefined);

const runLookupLoop = ({
  input,
  work,
  runActivity,
}: Readonly<{
  input: BillingObservationExecution;
  work: typeof LookupWork.Type;
  runActivity: RunActivity;
}>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const options = { retries: { limit: 0, delay: "1 second" } } as const;
      for (let index = 0; index < maximumCandidateLookupAttempts; index++) {
        if (index > 0) {
          yield* attempt(() =>
            input.sleep(`billing-observation-wait-v2-${index}`, candidateCooldownMs + 1)
          );
        }
        yield* attempt(() =>
          input.activity(`lookup-wompi-billing-v2-${index}`, options, () =>
            runObservedLookup({ execution: input, work, index, runActivity })
          )
        );
      }
    })
  );

type LookupGeneration = Pick<typeof LookupWork.Type, "transactionId" | "signedAt" | "signedStatus">;
const lookupEligibility = `FROM billing_provider_transactions c
  LEFT JOIN billing_attempt_context a ON a.id=c.attempt_id
  WHERE c.transaction_id=? AND c.event_signed_at IS ? AND c.event_signed_status IS ?`;
const attemptEligible = `a.status='pending' AND c.lookup_attempts<8`;
const eventEligible = `c.event_received_at_ms>=? AND c.event_resolved_at_ms IS NULL
  AND c.event_lookup_attempts<8 AND (a.id IS NULL OR a.status='pending'
  OR (a.status='failed' AND c.event_received_at_ms>=a.finalized_at_ms))`;
const reserveLookup = (
  db: D1Database,
  generation: LookupGeneration,
  now: number
): Effect.Effect<boolean, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const key = [generation.transactionId, generation.signedAt, generation.signedStatus];
    const results = yield* attempt(() =>
      db.batch([
        db
          .prepare(`UPDATE billing_provider_transactions SET last_checked_at_ms=?,lookup_attempts=lookup_attempts+1
        WHERE transaction_id IN (SELECT c.transaction_id ${lookupEligibility}
          AND ${attemptEligible} AND (c.last_checked_at_ms IS NULL OR c.last_checked_at_ms<?))
        RETURNING lookup_attempts,event_lookup_attempts`)
          .bind(now, ...key, now - candidateCooldownMs),
        db
          .prepare(`UPDATE billing_provider_transactions SET event_last_checked_at_ms=?,event_lookup_attempts=event_lookup_attempts+1
        WHERE transaction_id IN (SELECT c.transaction_id ${lookupEligibility}
          AND ${eventEligible} AND (c.event_last_checked_at_ms IS NULL OR c.event_last_checked_at_ms<?))
        RETURNING lookup_attempts,event_lookup_attempts`)
          .bind(now, ...key, now - eventCandidateLifetimeMs, now - candidateCooldownMs),
      ])
    );
    const first = results[0];
    const second = results[1];
    if (first === undefined || second === undefined) return yield* failure();
    if (first.meta.changes === 0 && second.meta.changes === 0) return false;
    return true;
  });
const initialLookupReservation = (
  db: D1Database,
  work: typeof LookupWork.Type,
  now: number
): Effect.Effect<boolean, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const row = yield* attempt(() =>
      db
        .prepare(`SELECT c.transaction_id ${lookupEligibility}
      AND ((a.status='pending' AND c.lookup_attempts>0) OR
        (c.event_received_at_ms>=? AND c.event_resolved_at_ms IS NULL AND c.event_lookup_attempts>0
        AND (a.id IS NULL OR a.status='pending' OR (a.status='failed' AND c.event_received_at_ms>=a.finalized_at_ms))))`)
        .bind(work.transactionId, work.signedAt, work.signedStatus, now - eventCandidateLifetimeMs)
        .first()
    );
    return row !== null;
  });

const lookupExecutionId = ({
  transactionId,
  signedAt,
  signedStatus,
}: Readonly<{
  transactionId: WompiTransactionId;
  signedAt: Option.Option<number>;
  signedStatus: Option.Option<string>;
}>): Effect.Effect<string, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const fingerprint = Hex.encode(
      new Uint8Array(
        yield* attempt(() =>
          crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              `${transactionId}:${Option.getOrElse(signedAt, () => 0)}:${Option.getOrElse(signedStatus, () => "")}`
            )
          )
        )
      )
    );
    return `billing-lookup-v2-${fingerprint}`;
  });
const offerBillingLookup = (
  input: Readonly<{
    db: D1Database;
    workflow: BillingObservationWorkflow;
    transactionId: WompiTransactionId;
    signedAt: Option.Option<number>;
    signedStatus: Option.Option<string>;
    now: number;
  }>
): Effect.Effect<boolean, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const { db, workflow, transactionId, signedAt, signedStatus, now } = input;
    const id = yield* lookupExecutionId({ transactionId, signedAt, signedStatus });
    const generation = {
      transactionId,
      signedAt: Option.getOrNull(signedAt),
      signedStatus: Option.getOrNull(signedStatus),
    };
    return yield* offerBillingWorkflow({
      workflow,
      id,
      params: { version: 2, kind: "lookup", ...generation },
      reserve: reserveLookup(db, generation, now),
    });
  });

/** Recheck known candidates by starting a bounded, named Workflow Activity. Failed handoffs retain D1 intent. */
export const reconcileBillingCandidates = (
  environment: Readonly<{ DB: D1Database; BILLING_COLLECTION_WORKFLOW: BillingObservationWorkflow }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* attempt(() =>
      environment.DB.prepare(`WITH candidates AS (SELECT transaction_id, MAX(signed_at) AS signed_at,
      MAX(signed_status) AS signed_status, MIN(priority) AS priority FROM (
      SELECT c.transaction_id, COALESCE(c.last_checked_at_ms, a.created_at_ms) AS priority,
        c.event_signed_at AS signed_at, c.event_signed_status AS signed_status
        FROM billing_provider_transactions AS c
        JOIN billing_attempt_context AS a ON a.id = c.attempt_id WHERE a.status = 'pending'
          AND c.lookup_attempts < ?
          AND (c.last_checked_at_ms IS NULL OR c.last_checked_at_ms < ?)
      UNION
      SELECT c.transaction_id, COALESCE(c.last_checked_at_ms, c.received_at_ms) AS priority,
        c.signed_at, c.signed_status FROM billing_callback_hints AS c
        LEFT JOIN billing_provider_transactions AS e ON e.transaction_id = c.transaction_id
        LEFT JOIN billing_attempt_context AS a ON a.id = e.attempt_id
        WHERE c.resolved_at_ms IS NULL AND c.lookup_attempts < ?
        AND c.received_at_ms >= ?
        AND (c.last_checked_at_ms IS NULL OR c.last_checked_at_ms < ?)
        AND (a.id IS NULL OR a.status = 'pending' OR (a.status = 'failed'
          AND c.received_at_ms >= a.finalized_at_ms))
    ) GROUP BY transaction_id), ranked AS (
      SELECT *,row_number() OVER (ORDER BY priority,transaction_id)-1 AS position,
        count(*) OVER () AS candidate_count FROM candidates
    ) SELECT transaction_id,signed_at,signed_status FROM ranked
      ORDER BY (position+?)%candidate_count LIMIT ?`)
        .bind(
          maximumCandidateLookupAttempts,
          now - candidateCooldownMs,
          maximumCandidateLookupAttempts,
          now - eventCandidateLifetimeMs,
          now - candidateCooldownMs,
          Math.floor(now / candidateCooldownMs) * pendingBatchSize,
          pendingBatchSize
        )
        .all()
    );
    const candidates = yield* decode(Schema.Array(Candidate), rows.results);
    let failed = false;
    for (const candidate of candidates) {
      const offered = yield* Effect.exit(
        offerBillingLookup({
          db: environment.DB,
          workflow: environment.BILLING_COLLECTION_WORKFLOW,
          transactionId: candidate.transaction_id,
          signedAt: candidate.signed_at,
          signedStatus: candidate.signed_status,
          now,
        })
      );
      if (Exit.isFailure(offered) || !offered.value) failed = true;
    }
    if (failed) return yield* failure();
  }).pipe(Effect.withSpan("billing.collection.reconcile"));
