import {
  captureWorkTrace,
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  sanitizeWorkTrace,
  workTraceParent,
  workerRelease,
} from "../../runtime/telemetry/operations";
import { receivePriceNotice, sendPriceNotice } from "./price-notice";
import { WompiEnvironment } from "../../../src/shell/secret-material/contract";
import { BillingAttemptId } from "../../../src/core/subscription/contract";
import { verifiedWompiEventHint } from "./wompi-event";
import { type WorkflowStepConfig } from "cloudflare:workers";
import { Clock, Effect, Exit, Option, Schema } from "effect";
import { type WompiTransportFactory } from "./wompi-runtime";
import {
  type BillingCollectionEnvironment,
  BillingCollectionFailure,
  type BillingObservationWorkflow,
  BillingPriceNoticeWork,
  type BillingRuntime,
  SubscriptionCancellationWork,
} from "../contract";

import { collectBillingTransaction } from "./billing-transaction";
import { receiveSourceCancellation, runBillingObservation } from "./billing-observation";

const CollectionMessage = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  version: Schema.Literal(1),
  attemptId: BillingAttemptId,
});
const workflowRetention = { successRetention: "3 days", errorRetention: "3 days" } as const;
type CollectionQueue = Readonly<{
  send: (work: typeof CollectionMessage.Type) => Promise<unknown>;
}>;
type CollectionWorkflow = BillingObservationWorkflow;
/** Identify this Queue payload without interpreting any provider data as authority. */
export const isBillingCollectionWork = (body: unknown): boolean =>
  Option.isSome(
    Schema.decodeUnknownOption(
      Schema.Union([CollectionMessage, BillingPriceNoticeWork, SubscriptionCancellationWork])
    )(body)
  );
const ArmState = Schema.Struct({ state: Schema.Literals(["armed", "sent", "rejected"]) });
const pendingBatchSize = 32;
const dispatchCooldownMs = 60_000;
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

const publishBillingEntry = (
  input: Readonly<{
    environment: Readonly<{ DB: D1Database; BILLING_COLLECTION_QUEUE: CollectionQueue }>;
    entry: { readonly attempt_id: BillingAttemptId };
    now: number;
  }>
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const trace = yield* captureWorkTrace;
    const { environment, entry, now } = input;
    const claimed = yield* Effect.exit(
      attempt(() =>
        environment.DB.prepare(`UPDATE billing_attempts AS billing_collection_work SET collection_last_attempt_at_ms = ? WHERE collection_state IS NOT NULL AND id = ?
      AND (collection_last_attempt_at_ms IS NULL OR collection_last_attempt_at_ms < ?)`)
          .bind(now, entry.attempt_id, now - dispatchCooldownMs)
          .run()
      )
    );
    if (Exit.isFailure(claimed)) return false;
    if (claimed.value.meta.changes !== 1) return true;
    const offered = yield* Effect.exit(
      attempt(() =>
        environment.BILLING_COLLECTION_QUEUE.send({
          ...trace,
          version: 1,
          attemptId: entry.attempt_id,
        })
      )
    );
    if (Exit.isFailure(offered)) return false;
    return true;
  });

/** Offer bounded, secret-free work identities. D1 intent remains authoritative on Queue failure. */
export const dispatchBillingCollection = (
  environment: Readonly<{ DB: D1Database; BILLING_COLLECTION_QUEUE: CollectionQueue }> & {
    readonly identity: Option.Option<string>;
  }
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const identity = environment.identity;
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* attempt(() =>
      environment.DB.prepare(`SELECT o.attempt_id
      FROM (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempt_context WHERE collection_state IS NOT NULL) AS o
      WHERE o.state = 'armed' AND (o.last_attempt_at_ms IS NULL OR o.last_attempt_at_ms < ?)
        AND (? IS NULL OR o.attempt_id = ?)
      ORDER BY o.last_attempt_at_ms, o.attempt_id LIMIT ?`)
        .bind(
          now - dispatchCooldownMs,
          Option.getOrNull(identity),
          Option.getOrNull(identity),
          pendingBatchSize
        )
        .all()
    );
    const entries = yield* decode(
      Schema.Array(Schema.Struct({ attempt_id: BillingAttemptId })),
      rows.results
    );
    let failed = false;
    for (const entry of entries) {
      const published = yield* publishBillingEntry({ environment, entry, now });
      if (!published) failed = true;
    }
    if (failed) return yield* failure();
  }).pipe(Effect.withSpan("billing.collection.dispatch"));

const receiveAuxiliaryWork = (
  environment: Readonly<{ DB: D1Database; BILLING_COLLECTION_WORKFLOW: CollectionWorkflow }>,
  work: typeof BillingPriceNoticeWork.Type | typeof SubscriptionCancellationWork.Type
): Effect.Effect<void, BillingCollectionFailure> =>
  work.kind === "source-cancellation"
    ? receiveSourceCancellation({
        db: environment.DB,
        workflow: environment.BILLING_COLLECTION_WORKFLOW,
        work,
      })
    : receivePriceNotice({ environment, work });

/** Duplicated Queue messages converge on one deterministic Workflow instance. */
export const receiveBillingCollection = (
  input: Readonly<{
    environment: Readonly<{ DB: D1Database; BILLING_COLLECTION_WORKFLOW: CollectionWorkflow }>;
    batch: Readonly<{ messages: ReadonlyArray<{ body: unknown; ack: () => void }> }>;
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    for (const message of input.batch.messages) {
      const work = Schema.decodeUnknownOption(
        Schema.Union([CollectionMessage, BillingPriceNoticeWork, SubscriptionCancellationWork])
      )(message.body);
      if (Option.isNone(work)) {
        message.ack();
        continue;
      }
      if ("kind" in work.value) {
        yield* receiveAuxiliaryWork(input.environment, work.value);
        message.ack();
        continue;
      }
      const collection = work.value;
      const row = yield* attempt(() =>
        input.environment.DB.prepare(
          "SELECT state FROM (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempt_context WHERE collection_state IS NOT NULL) AS billing_collection_work WHERE attempt_id = ?"
        )
          .bind(collection.attemptId)
          .first()
      );
      const arm = Schema.decodeUnknownOption(ArmState)(row);
      if (Option.isNone(arm) || arm.value.state !== "armed") {
        message.ack();
        continue;
      }
      const params = yield* sanitizeWorkTrace(collection);
      const started = yield* Effect.exit(
        attempt(() =>
          input.environment.BILLING_COLLECTION_WORKFLOW.create({
            id: collection.attemptId,
            params,
            retention: workflowRetention,
          })
        )
      );
      if (Exit.isFailure(started)) {
        yield* attempt(() =>
          input.environment.BILLING_COLLECTION_WORKFLOW.get(collection.attemptId)
        );
      }
      message.ack();
    }
  }).pipe(Effect.withSpan("billing.collection.receive"));

/** A valid signed event persists only a bounded transaction-id hint, then independently verifies provider evidence. */
export const receiveWompiBillingEvent = (
  input: Readonly<{
    request: Request;
    environment: BillingRuntime & Pick<BillingCollectionEnvironment, "WOMPI_EVENT_SECRET">;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const configured = Schema.decodeUnknownOption(WompiEnvironment)(
      input.environment.WOMPI_ENVIRONMENT
    );
    if (Option.isNone(configured)) return new Response(null, { status: 503 });
    const prefix = configured.value === "sandbox" ? "test_events_" : "prod_events_";
    if (!input.environment.WOMPI_EVENT_SECRET.startsWith(prefix)) {
      return new Response(null, { status: 503 });
    }
    const verified = yield* Effect.exit(
      verifiedWompiEventHint({
        request: input.request,
        secret: input.environment.WOMPI_EVENT_SECRET,
        environment: configured.value,
      })
    );
    if (Exit.isFailure(verified) || Option.isNone(verified.value)) {
      return new Response(null, { status: 400 });
    }
    const { transactionId, signedAt, signedStatus } = verified.value.value;
    const now = yield* Clock.currentTimeMillis;
    const retained = yield* Effect.exit(
      attempt(() =>
        input.environment.DB.prepare(`INSERT INTO billing_provider_transactions
      (transaction_id,event_received_at_ms,event_signed_at,event_signed_status,event_lookup_attempts) VALUES (?, ?, ?, ?,0) ON CONFLICT(transaction_id) DO UPDATE SET event_received_at_ms = excluded.event_received_at_ms,
        event_signed_at = excluded.event_signed_at, event_signed_status = excluded.event_signed_status,
        event_lookup_attempts = 0, event_last_checked_at_ms = NULL, event_resolved_at_ms = NULL
      WHERE billing_provider_transactions.event_received_at_ms IS NULL OR ((excluded.event_signed_at > billing_provider_transactions.event_signed_at OR
        (excluded.event_signed_at = billing_provider_transactions.event_signed_at
          AND excluded.event_signed_status = 'APPROVED'
          AND billing_provider_transactions.event_signed_status <> 'APPROVED'))
        AND NOT EXISTS (SELECT 1 FROM billing_provider_transactions AS e
          JOIN billing_attempt_context AS a ON a.id = e.attempt_id
          WHERE e.transaction_id = excluded.transaction_id AND a.status = 'succeeded'))`)
          .bind(transactionId, now, signedAt, signedStatus)
          .run()
      )
    );
    if (Exit.isFailure(retained)) return new Response(null, { status: 503 });
    return new Response(null, { status: 200 });
  });

type CollectionActivity = (
  name: string,
  options: WorkflowStepConfig,
  run: () => Promise<void>
) => Promise<void>;

type BillingWorkflowExecution = Readonly<{
  environment: BillingRuntime;
  payload: unknown;
  activity: CollectionActivity;
  sleep: (name: string, duration: number) => Promise<void>;
  wompiHttp: WompiTransportFactory;
}>;
/** Only a versioned identity enters Workflow state. The named Activity owns the one armed POST. */
export const runBillingCollectionWorkflow = (input: BillingWorkflowExecution): Promise<void> => {
  const { wompiHttp } = input;
  const work = Schema.decodeUnknownOption(
    Schema.Union([CollectionMessage, BillingPriceNoticeWork])
  )(input.payload);
  if (Option.isNone(work)) return runBillingObservation(input);
  const options = { retries: { limit: 0, delay: "1 second" } } as const;
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
  if ("kind" in work.value) {
    const notice = work.value;
    return input.activity("send-billing-price-notice-v1", options, () =>
      runActivity(sendPriceNotice({ environment: input.environment, work: notice }))
    );
  }
  const attemptId = work.value.attemptId;
  return input.activity("collect-wompi-billing-v1", options, () =>
    runActivity(collectBillingTransaction({ environment: input.environment, attemptId, wompiHttp }))
  );
};
