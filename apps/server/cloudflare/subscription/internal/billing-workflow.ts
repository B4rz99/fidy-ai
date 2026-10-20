import {
  captureWorkTrace,
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  sanitizeWorkTrace,
  workTraceParent,
  workerRelease,
} from "../../runtime/telemetry/operations";
import { cancelSource, receiveCancellation } from "./source-cancellation";
import { receivePriceNotice, sendPriceNotice } from "./price-notice";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { UserId } from "../../../src/core/identity/contract";
import { WompiEnvironment } from "../../../src/shell/secret-material/contract";
import {
  BillingAttemptId,
  BillingEmail,
  EnrollmentMethod,
  renewalGraceMs,
} from "../../../src/core/subscription/contract";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { Money } from "../../../src/core/_shared/money";
import {
  type WompiBillingClientService,
  type WompiTransaction,
  makeWompiBillingClient,
} from "./wompi-billing-client";
import { WompiSourceId, WompiTransactionId, WompiTransactionReference } from "./wompi-model";
import { amountInCentsForBilling } from "./billing-rules";
import { paidPeriodFor } from "../../../src/core/subscription/operations";
import { type VerifiedOutcome, recordVerifiedBillingEvidence } from "./billing-settlement";
import { verifiedWompiEventHint } from "./wompi-event";
import { type WorkflowStepConfig } from "cloudflare:workers";
import { Clock, DateTime, Effect, Exit, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { type WompiTransportFactory } from "./wompi-runtime";
import {
  type BillingCollectionEnvironment,
  BillingCollectionFailure,
  BillingPriceNoticeWork,
  type BillingRuntime,
  type BillingWorkflowStarter,
  SubscriptionCancellationWork,
} from "../contract";

const CollectionMessage = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  version: Schema.Literal(1),
  attemptId: BillingAttemptId,
});
const LookupWork = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  version: Schema.Literal(1),
  kind: Schema.Literal("lookup"),
  transactionId: WompiTransactionId,
});
const workflowRetention = { successRetention: "3 days", errorRetention: "3 days" } as const;
type CollectionQueue = Readonly<{
  send: (work: typeof CollectionMessage.Type) => Promise<unknown>;
}>;
type CollectionWorkflow = BillingWorkflowStarter;
type LookupWorkflowBinding = Readonly<{
  create: (options: {
    id: string;
    params: typeof LookupWork.Type;
    retention: typeof workflowRetention;
  }) => Promise<unknown>;
  get: (id: string) => Promise<unknown>;
}>;
/** Identify this Queue payload without interpreting any provider data as authority. */
export const isBillingCollectionWork = (body: unknown): boolean =>
  Option.isSome(
    Schema.decodeUnknownOption(
      Schema.Union([CollectionMessage, BillingPriceNoticeWork, SubscriptionCancellationWork])
    )(body)
  );
const Snapshot = Schema.Struct({
  id: BillingAttemptId,
  user_id: Schema.String.check(Schema.isUUID()),
  amount: Schema.String,
  currency: Schema.Literal("COP"),
  billing_period: Schema.Literals(["weekly", "monthly", "yearly"]),
  time_zone: IanaTimeZone,
  wompi_environment: WompiEnvironment,
  wompi_reference: WompiTransactionReference,
  billing_email: BillingEmail,
  wompi_source_id: WompiSourceId,
  method: EnrollmentMethod,
  previous_paid_attempt_id: Schema.OptionFromNullOr(BillingAttemptId),
  period_starts_at_ms: Schema.OptionFromNullOr(Schema.Int),
  period_ends_at_ms: Schema.OptionFromNullOr(Schema.Int),
});
const Candidate = Schema.Struct({
  transaction_id: WompiTransactionId,
  signed_at: Schema.OptionFromNullOr(Schema.Finite),
  signed_status: Schema.OptionFromNullOr(Schema.String),
});
const ArmState = Schema.Struct({ state: Schema.Literals(["armed", "sent", "rejected"]) });
const billingAmount = (
  captured: typeof Snapshot.Type
): Effect.Effect<number, BillingCollectionFailure> =>
  Effect.flatMap(decode(Money, { amount: captured.amount, currency: captured.currency }), (money) =>
    amountInCentsForBilling(money.amount)
  );
const pendingBatchSize = 32;
const dispatchCooldownMs = 60_000;
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

const billingClient = (
  environment: BillingRuntime,
  wompiHttp: WompiTransportFactory
): Effect.Effect<WompiBillingClientService, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const configured = yield* decode(WompiEnvironment, environment.WOMPI_ENVIRONMENT);
    const outboundHttp = yield* wompiHttp({
      ...environment,
      WOMPI_ENVIRONMENT: configured,
    });
    return makeWompiBillingClient({ outboundHttp, environment: configured });
  });

const snapshot = (
  db: D1Database,
  id: BillingAttemptId
): Effect.Effect<typeof Snapshot.Type, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const row = yield* attempt(() =>
      db
        .prepare(`SELECT a.id, a.user_id, a.amount, a.currency, a.billing_period, a.time_zone,
          a.wompi_environment, a.wompi_reference, s.billing_email, s.wompi_source_id, s.method,
          a.previous_paid_attempt_id, a.period_starts_at_ms, a.period_ends_at_ms
        FROM billing_attempts AS a JOIN verified_payment_sources AS s ON s.id = a.payment_source_id
        WHERE a.id = ? AND a.user_id = s.user_id`)
        .bind(id)
        .first()
    );
    return yield* decode(Snapshot, row);
  });

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
      FROM (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempts WHERE collection_state IS NOT NULL) AS o
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
    ? receiveCancellation({
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
          "SELECT state FROM (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempts WHERE collection_state IS NOT NULL) AS billing_collection_work WHERE attempt_id = ?"
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

const matchesSnapshot = (
  input: Readonly<{
    found: WompiTransaction;
    captured: typeof Snapshot.Type;
    expectedId: WompiTransactionId;
    expectedAmount: number;
    environment: WompiEnvironment;
    requireFinalization: boolean;
  }>
): boolean => {
  const facts: ReadonlyArray<readonly [unknown, unknown]> = [
    [input.found.transactionId, input.expectedId],
    [input.found.reference, input.captured.wompi_reference],
    [input.found.amountInCents, input.expectedAmount],
    [input.found.currency, input.captured.currency],
    [input.environment, input.captured.wompi_environment],
  ];
  return (
    facts.every(([observed, expected]) => observed === expected) &&
    (Option.isNone(input.found.sourceId) ||
      input.found.sourceId.value === input.captured.wompi_source_id) &&
    (!input.requireFinalization ||
      input.found.status !== "APPROVED" ||
      Option.isSome(input.found.finalizedAt))
  );
};

const verifiedSnapshot = (
  input: Readonly<{
    db: D1Database;
    client: WompiBillingClientService;
    transactionId: WompiTransactionId;
    found: WompiTransaction;
  }>
): Effect.Effect<typeof Snapshot.Type, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const row = yield* attempt(() =>
      input.db
        .prepare(
          "SELECT id FROM billing_attempts WHERE wompi_reference = ? AND wompi_environment = ?"
        )
        .bind(input.found.reference, input.client.environment)
        .first()
    );
    const match = yield* decode(Schema.Struct({ id: BillingAttemptId }), row);
    const captured = yield* snapshot(input.db, match.id);
    const amount = yield* billingAmount(captured);
    if (
      !matchesSnapshot({
        found: input.found,
        captured,
        expectedId: input.transactionId,
        expectedAmount: amount,
        environment: input.client.environment,
        requireFinalization: true,
      })
    ) {
      return yield* failure();
    }
    return captured;
  });

/** A provider id is a lookup hint only: provider GET and the full captured snapshot authorize evidence. */
export const reconcileBillingTransaction = (
  input: Readonly<{
    db: D1Database;
    client: WompiBillingClientService;
    transactionId: WompiTransactionId;
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const found = yield* input.client
      .findTransaction(input.transactionId)
      .pipe(Effect.mapError((cause) => failure(Option.some(cause))));
    const captured = yield* verifiedSnapshot({ ...input, found });
    const now = yield* Clock.currentTimeMillis;
    let settlement: VerifiedOutcome;
    if (found.status === "APPROVED") {
      if (Option.isNone(found.finalizedAt)) return yield* failure();
      const period = Option.isSome(captured.previous_paid_attempt_id)
        ? {
            startsAt: DateTime.makeUnsafe(Option.getOrThrow(captured.period_starts_at_ms)),
            endsAt: DateTime.makeUnsafe(Option.getOrThrow(captured.period_ends_at_ms)),
            renewalAnchor: DateTime.makeUnsafe(Option.getOrThrow(captured.period_ends_at_ms)),
          }
        : yield* paidPeriodFor(
            captured.billing_period,
            captured.time_zone,
            found.finalizedAt.value
          );
      settlement = {
        status: "APPROVED",
        finalizedAtMs: DateTime.toEpochMillis(found.finalizedAt.value),
        paidPeriod: {
          startsAtMs: DateTime.toEpochMillis(period.startsAt),
          endsAtMs: DateTime.toEpochMillis(period.endsAt),
          renewalAnchorMs: DateTime.toEpochMillis(period.renewalAnchor),
        },
      };
    } else {
      settlement = {
        status: found.status,
        finalizedAtMs: Option.map(found.finalizedAt, DateTime.toEpochMillis),
      };
    }
    yield* attempt(() =>
      recordVerifiedBillingEvidence({
        db: input.db,
        attemptId: captured.id,
        transactionId: input.transactionId,
        observedAtMs: now,
        outcome: settlement,
      })
    );
  });

const reconcileEventCandidate = (
  environment: BillingRuntime,
  transactionId: WompiTransactionId,
  wompiHttp: WompiTransportFactory
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const client = yield* billingClient(environment, wompiHttp);
    yield* reconcileBillingTransaction({ db: environment.DB, client, transactionId });
    const now = yield* Clock.currentTimeMillis;
    yield* attempt(() =>
      environment.DB.prepare(`UPDATE billing_provider_transactions
      SET event_resolved_at_ms = ? WHERE transaction_id = ? AND event_received_at_ms IS NOT NULL AND event_resolved_at_ms IS NULL
      AND EXISTS (SELECT 1 FROM billing_provider_transactions AS e
        JOIN billing_attempts AS a ON a.id = e.attempt_id
        WHERE e.transaction_id = ? AND a.status IN ('succeeded', 'failed'))`)
        .bind(now, transactionId, transactionId)
        .run()
    );
  }).pipe(Effect.withSpan("billing.collection.lookup"));

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
          JOIN billing_attempts AS a ON a.id = e.attempt_id
          WHERE e.transaction_id = excluded.transaction_id AND a.status = 'succeeded'))`)
          .bind(transactionId, now, signedAt, signedStatus)
          .run()
      )
    );
    if (Exit.isFailure(retained)) return new Response(null, { status: 503 });
    return new Response(null, { status: 200 });
  });

const claimCollection = (
  input: Readonly<{
    environment: BillingRuntime;
    captured: typeof Snapshot.Type;
    attemptId: BillingAttemptId;
    now: number;
  }>
): Effect.Effect<boolean, BillingCollectionFailure> => {
  const { environment, captured, attemptId, now } = input;
  const collectionClaim = {
    sql: `UPDATE billing_attempts AS billing_collection_work SET collection_state = 'sent', collection_sent_at_ms = ? WHERE collection_state IS NOT NULL AND id = ? AND collection_state = 'armed'`,
    params: [now, attemptId],
  };
  const protectedClaim = Option.isSome(captured.previous_paid_attempt_id)
    ? protectConsentStatement({
        subject: { _tag: "User", userId: UserId.make(captured.user_id) },
        requirement: "active",
        statement: {
          sql: `${collectionClaim.sql}
            AND EXISTS (SELECT 1 FROM subscription_standing WHERE user_id = ? AND attempt_id = ?)
            AND NOT EXISTS (SELECT 1 FROM subscription_renewal_fences WHERE user_id = ?)
            AND EXISTS (SELECT 1 FROM billing_attempts due WHERE due.id=? AND
              (due.renewal_attempt_number=1 OR due.period_starts_at_ms + ${renewalGraceMs} > ?))`,
          params: [
            ...collectionClaim.params,
            captured.user_id,
            captured.previous_paid_attempt_id.value,
            captured.user_id,
            attemptId,
            now,
          ],
        },
      })
    : collectionClaim;
  return attempt(() =>
    environment.DB.prepare(protectedClaim.sql)
      .bind(...protectedClaim.params)
      .run()
  ).pipe(Effect.map((result) => result.meta.changes === 1));
};

const collect = (
  environment: BillingRuntime,
  attemptId: BillingAttemptId,
  wompiHttp: WompiTransportFactory
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const captured = yield* snapshot(environment.DB, attemptId);
    if (captured.wompi_environment !== environment.WOMPI_ENVIRONMENT) return yield* failure();
    const client = yield* billingClient(environment, wompiHttp);
    const amount = yield* billingAmount(captured);
    // Claim BEFORE outbound I/O: a crash between this write and POST is ambiguous, never retried blindly.
    const now = yield* Clock.currentTimeMillis;
    const claimed = yield* claimCollection({ environment, captured, attemptId, now });
    if (!claimed) return;
    const created = yield* Effect.exit(
      client.createTransaction({
        reference: captured.wompi_reference,
        amountInCents: amount,
        currency: captured.currency,
        billingEmail: captured.billing_email,
        sourceId: captured.wompi_source_id,
        method: captured.method,
      })
    );
    // Wompi documents charge lookup by provider id, not by reference. Without a response id,
    // retain ambiguity until a signed callback supplies a lookup hint; NEVER repeat the POST.
    if (Exit.isFailure(created)) return;
    if (
      !matchesSnapshot({
        found: created.value,
        captured,
        expectedId: created.value.transactionId,
        expectedAmount: amount,
        environment: client.environment,
        requireFinalization: false,
      })
    ) {
      return;
    }
    const candidate = created.value.transactionId;
    yield* attempt(() =>
      environment.DB.batch([
        environment.DB.prepare(`INSERT INTO billing_provider_transactions
      (transaction_id, attempt_id) VALUES (?, ?)
      ON CONFLICT(transaction_id) DO UPDATE SET attempt_id=excluded.attempt_id
      WHERE billing_provider_transactions.attempt_id IS NULL`).bind(candidate, attemptId),
        ...(captured.method === "card" && Option.isNone(captured.previous_paid_attempt_id)
          ? [
              environment.DB.prepare(
                `UPDATE billing_attempts SET checkout_transaction_id=incoming.transaction_id FROM (SELECT ? AS attempt_id,? AS transaction_id) AS incoming WHERE billing_attempts.id=incoming.attempt_id AND billing_attempts.checkout_transaction_id IS NULL`
              ).bind(attemptId, candidate),
            ]
          : []),
      ])
    );
    yield* reconcileBillingTransaction({ db: environment.DB, client, transactionId: candidate });
  }).pipe(Effect.withSpan("billing.collection.collect"));

type CollectionActivity = (
  name: string,
  options: WorkflowStepConfig,
  run: () => Promise<void>
) => Promise<void>;

/** Only a versioned identity enters Workflow state. The named Activity owns the one armed POST. */
export const runBillingCollectionWorkflow = (
  input: Readonly<{
    environment: BillingRuntime;
    payload: unknown;
    activity: CollectionActivity;
    wompiHttp: WompiTransportFactory;
  }>
): Promise<void> => {
  const { wompiHttp } = input;
  const work = Schema.decodeUnknownOption(
    Schema.Union([
      CollectionMessage,
      LookupWork,
      BillingPriceNoticeWork,
      SubscriptionCancellationWork,
    ])
  )(input.payload);
  if (Option.isNone(work)) return Promise.resolve();
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
  if ("kind" in work.value && work.value.kind === "price-notice") {
    const notice = work.value;
    return input.activity("send-billing-price-notice-v1", options, () =>
      runActivity(sendPriceNotice({ environment: input.environment, work: notice }))
    );
  }
  if ("kind" in work.value && work.value.kind === "source-cancellation") {
    const cancellation = work.value;
    return input.activity("cancel-wompi-source-v1", options, () =>
      runActivity(cancelSource({ environment: input.environment, work: cancellation, wompiHttp }))
    );
  }
  if ("kind" in work.value) {
    const transactionId = work.value.transactionId;
    return input.activity("lookup-wompi-billing-v1", options, () =>
      runActivity(reconcileEventCandidate(input.environment, transactionId, wompiHttp))
    );
  }
  const attemptId = work.value.attemptId;
  return input.activity("collect-wompi-billing-v1", options, () =>
    runActivity(collect(input.environment, attemptId, wompiHttp))
  );
};

const offerBillingLookup = (
  input: Readonly<{
    db: D1Database;
    workflow: LookupWorkflowBinding;
    transactionId: WompiTransactionId;
    signedAt: Option.Option<number>;
    signedStatus: Option.Option<string>;
    now: number;
  }>
): Effect.Effect<boolean, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const { db, workflow, transactionId, signedAt, signedStatus, now } = input;
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
    const id = `billing-lookup-v1-${fingerprint}-${Math.floor(now / candidateCooldownMs)}`;
    const recorded = yield* attempt(() =>
      db.batch([
        db
          .prepare(
            "UPDATE billing_provider_transactions SET last_checked_at_ms = ?, lookup_attempts = lookup_attempts + 1 WHERE transaction_id = ? AND attempt_id IS NOT NULL AND lookup_attempts < ? AND (last_checked_at_ms IS NULL OR last_checked_at_ms < ?)"
          )
          .bind(now, transactionId, maximumCandidateLookupAttempts, now - candidateCooldownMs),
        db
          .prepare(
            "UPDATE billing_provider_transactions SET event_last_checked_at_ms = ?, event_lookup_attempts = event_lookup_attempts + 1 WHERE transaction_id = ? AND event_lookup_attempts < ? AND event_resolved_at_ms IS NULL AND (event_last_checked_at_ms IS NULL OR event_last_checked_at_ms < ?)"
          )
          .bind(now, transactionId, maximumCandidateLookupAttempts, now - candidateCooldownMs),
      ])
    );
    if (recorded.every((result) => result.meta.changes === 0)) return true;
    const created = yield* Effect.exit(
      attempt(() =>
        workflow.create({
          id,
          params: { version: 1, kind: "lookup", transactionId },
          retention: workflowRetention,
        })
      )
    );
    if (Exit.isFailure(created)) {
      const existing = yield* Effect.exit(attempt(() => workflow.get(id)));
      if (Exit.isFailure(existing)) return false;
    }
    return true;
  });

/** Recheck known candidates by starting a bounded, named Workflow Activity. Failed handoffs retain D1 intent. */
export const reconcileBillingCandidates = (
  environment: Readonly<{ DB: D1Database; BILLING_COLLECTION_WORKFLOW: LookupWorkflowBinding }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* attempt(() =>
      environment.DB.prepare(`SELECT transaction_id, MAX(signed_at) AS signed_at,
      MAX(signed_status) AS signed_status FROM (
      SELECT c.transaction_id, COALESCE(c.last_checked_at_ms, a.created_at_ms) AS priority,
        NULL AS signed_at, NULL AS signed_status
        FROM billing_provider_transactions AS c
        JOIN billing_attempts AS a ON a.id = c.attempt_id WHERE a.status = 'pending'
          AND c.lookup_attempts < ?
          AND (c.last_checked_at_ms IS NULL OR c.last_checked_at_ms < ?)
      UNION
      SELECT c.transaction_id, COALESCE(c.last_checked_at_ms, c.received_at_ms) AS priority,
        c.signed_at, c.signed_status FROM billing_callback_hints AS c
        LEFT JOIN billing_provider_transactions AS e ON e.transaction_id = c.transaction_id
        LEFT JOIN billing_attempts AS a ON a.id = e.attempt_id
        WHERE c.resolved_at_ms IS NULL AND c.lookup_attempts < ?
        AND c.received_at_ms >= ?
        AND (c.last_checked_at_ms IS NULL OR c.last_checked_at_ms < ?)
        AND (a.id IS NULL OR a.status = 'pending' OR (a.status = 'failed'
          AND c.received_at_ms >= a.finalized_at_ms))
    ) GROUP BY transaction_id ORDER BY MIN(priority) LIMIT ?`)
        .bind(
          maximumCandidateLookupAttempts,
          now - candidateCooldownMs,
          maximumCandidateLookupAttempts,
          now - eventCandidateLifetimeMs,
          now - candidateCooldownMs,
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
