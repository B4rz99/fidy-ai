import {
  BillingAttemptId,
  BillingEmail,
  IanaTimeZone,
  Money,
  type WompiBillingClientService,
  WompiEnvironment,
  WompiSourceId,
  type WompiTransaction,
  WompiTransactionId,
  WompiTransactionReference,
  amountInCentsForBilling,
  makeWompiBillingClient,
  paidPeriodFor,
} from "@fidy/server/subscription-runtime";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { type VerifiedOutcome, recordVerifiedBillingEvidence } from "./billing-settlement";
import { verifiedWompiEventHint } from "./wompi-event";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { Clock, Data, DateTime, Effect, Encoding, Exit, Option, Schema } from "effect";
import { wompiOutboundHttp } from "../wompi/wompi-runtime";

const CollectionMessage = Schema.Struct({
  version: Schema.Literal(1),
  attemptId: BillingAttemptId,
});
const LookupWork = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("lookup"),
  transactionId: WompiTransactionId,
});
// Version 1 is new: no legacy payload migration. D1 is authoritative after Workflow history expires.
// Three days fits Workers Free and Paid; expired execution IDs never rearm a sent mutation.
const workflowRetention = { successRetention: "3 days", errorRetention: "3 days" } as const;
type CollectionQueue = Readonly<{
  send: (work: typeof CollectionMessage.Type) => Promise<unknown>;
}>;
type CollectionWorkflow = Readonly<{
  create: (options: {
    id: string;
    params: typeof CollectionMessage.Type;
    retention: typeof workflowRetention;
  }) => Promise<unknown>;
  get: (id: string) => Promise<unknown>;
}>;
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
  Option.isSome(Schema.decodeUnknownOption(CollectionMessage)(body));
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

class BillingCollectionFailure extends Data.TaggedError("BillingCollectionFailure")<{
  readonly cause: Option.Option<unknown>;
}> {}
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

export type BillingCollectionEnvironment = Readonly<{
  DB: D1Database;
  BILLING_COLLECTION_QUEUE: Queue;
  BILLING_COLLECTION_WORKFLOW: Workflow;
  WOMPI_ENVIRONMENT: string;
  WOMPI_PUBLIC_KEY: string;
  WOMPI_PRIVATE_KEY: string;
  WOMPI_INTEGRITY_SECRET: string;
  WOMPI_EVENT_SECRET: string;
}>;

type BillingRuntime = Pick<
  BillingCollectionEnvironment,
  "DB" | "WOMPI_ENVIRONMENT" | "WOMPI_PUBLIC_KEY" | "WOMPI_PRIVATE_KEY" | "WOMPI_INTEGRITY_SECRET"
>;

const billingClient = (
  environment: BillingRuntime
): Effect.Effect<WompiBillingClientService, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const configured = yield* decode(WompiEnvironment, environment.WOMPI_ENVIRONMENT);
    const outboundHttp = yield* wompiOutboundHttp({
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
          a.wompi_environment, a.wompi_reference, s.billing_email, s.wompi_source_id
        FROM billing_attempts AS a JOIN card_payment_sources AS s ON s.id = a.payment_source_id
        WHERE a.id = ? AND a.user_id = s.user_id`)
        .bind(id)
        .first()
    );
    return yield* decode(Snapshot, row);
  });

const publishBillingEntry = (
  input: Readonly<{
    environment: Readonly<{ DB: D1Database; BILLING_COLLECTION_QUEUE: CollectionQueue }>;
    entry: { readonly attempt_id: BillingAttemptId; readonly version: 1 };
    now: number;
  }>
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const { environment, entry, now } = input;
    const claimed = yield* Effect.exit(
      attempt(() =>
        environment.DB.prepare(`UPDATE billing_collection_outbox
      SET last_attempt_at_ms = ? WHERE attempt_id = ?
      AND (last_attempt_at_ms IS NULL OR last_attempt_at_ms < ?)`)
          .bind(now, entry.attempt_id, now - dispatchCooldownMs)
          .run()
      )
    );
    if (Exit.isFailure(claimed)) return false;
    if (claimed.value.meta.changes !== 1) return true;
    const offered = yield* Effect.exit(
      attempt(() =>
        environment.BILLING_COLLECTION_QUEUE.send({
          version: entry.version,
          attemptId: entry.attempt_id,
        })
      )
    );
    if (Exit.isFailure(offered)) return false;
    const published = yield* Effect.exit(
      attempt(() =>
        environment.DB.prepare(
          "UPDATE billing_collection_outbox SET published_at_ms = ? WHERE attempt_id = ?"
        )
          .bind(now, entry.attempt_id)
          .run()
      )
    );
    return Exit.isSuccess(published);
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
      environment.DB.prepare(`SELECT o.attempt_id, o.version
      FROM billing_collection_outbox AS o JOIN billing_collection_arms AS arm ON arm.attempt_id = o.attempt_id
      WHERE arm.state = 'armed' AND (o.last_attempt_at_ms IS NULL OR o.last_attempt_at_ms < ?)
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
      Schema.Array(Schema.Struct({ attempt_id: BillingAttemptId, version: Schema.Literal(1) })),
      rows.results
    );
    let failed = false;
    for (const entry of entries) {
      const published = yield* publishBillingEntry({ environment, entry, now });
      if (!published) failed = true;
    }
    if (failed) return yield* failure();
  }).pipe(Effect.withSpan("billing.collection.dispatch"));

/** Duplicated Queue messages converge on one deterministic Workflow instance. */
export const receiveBillingCollection = (
  input: Readonly<{
    environment: Readonly<{ DB: D1Database; BILLING_COLLECTION_WORKFLOW: CollectionWorkflow }>;
    batch: Readonly<{ messages: ReadonlyArray<{ body: unknown; ack: () => void }> }>;
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    for (const message of input.batch.messages) {
      const work = Schema.decodeUnknownOption(CollectionMessage)(message.body);
      if (Option.isNone(work)) {
        message.ack();
        continue;
      }
      const row = yield* attempt(() =>
        input.environment.DB.prepare(
          "SELECT state FROM billing_collection_arms WHERE attempt_id = ?"
        )
          .bind(work.value.attemptId)
          .first()
      );
      const arm = Schema.decodeUnknownOption(ArmState)(row);
      if (Option.isNone(arm) || arm.value.state !== "armed") {
        message.ack();
        continue;
      }
      const started = yield* Effect.exit(
        attempt(() =>
          input.environment.BILLING_COLLECTION_WORKFLOW.create({
            id: work.value.attemptId,
            params: work.value,
            retention: workflowRetention,
          })
        )
      );
      if (Exit.isFailure(started)) {
        // A failed create may have succeeded remotely. Confirm the deterministic instance before ack.
        yield* attempt(() =>
          input.environment.BILLING_COLLECTION_WORKFLOW.get(work.value.attemptId)
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
      const period = yield* paidPeriodFor(
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
  transactionId: WompiTransactionId
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const client = yield* billingClient(environment);
    yield* reconcileBillingTransaction({ db: environment.DB, client, transactionId });
    const now = yield* Clock.currentTimeMillis;
    yield* attempt(() =>
      environment.DB.prepare(`UPDATE billing_event_candidates
      SET resolved_at_ms = ? WHERE transaction_id = ? AND resolved_at_ms IS NULL
      AND EXISTS (SELECT 1 FROM billing_transaction_evidence AS e
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
        input.environment.DB.prepare(`INSERT INTO billing_event_candidates
      (transaction_id, received_at_ms, signed_at, signed_status) VALUES (?, ?, ?, ?)
      ON CONFLICT(transaction_id) DO UPDATE SET received_at_ms = excluded.received_at_ms,
        signed_at = excluded.signed_at, signed_status = excluded.signed_status,
        lookup_attempts = 0, last_checked_at_ms = NULL, resolved_at_ms = NULL
      WHERE (excluded.signed_at > billing_event_candidates.signed_at OR
        (excluded.signed_at = billing_event_candidates.signed_at
          AND excluded.signed_status = 'APPROVED'
          AND billing_event_candidates.signed_status <> 'APPROVED'))
        AND NOT EXISTS (SELECT 1 FROM billing_transaction_evidence AS e
          JOIN billing_attempts AS a ON a.id = e.attempt_id
          WHERE e.transaction_id = excluded.transaction_id AND a.status = 'succeeded')`)
          .bind(transactionId, now, signedAt, signedStatus)
          .run()
      )
    );
    if (Exit.isFailure(retained)) return new Response(null, { status: 503 });
    // The durable hint is looked up by a named Workflow Activity, never from the ingress handler.
    return new Response(null, { status: 200 });
  });

const collect = (
  environment: BillingRuntime,
  attemptId: BillingAttemptId
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const captured = yield* snapshot(environment.DB, attemptId);
    if (captured.wompi_environment !== environment.WOMPI_ENVIRONMENT) return yield* failure();
    const client = yield* billingClient(environment);
    const amount = yield* billingAmount(captured);
    // Claim BEFORE outbound I/O: a crash between this write and POST is ambiguous, never retried blindly.
    const now = yield* Clock.currentTimeMillis;
    const claimed = yield* attempt(() =>
      environment.DB.prepare(`UPDATE billing_collection_arms
      SET state = 'sent', sent_at_ms = ? WHERE attempt_id = ? AND state = 'armed'`)
        .bind(now, attemptId)
        .run()
    );
    if (claimed.meta.changes !== 1) return;
    const created = yield* Effect.exit(
      client.createTransaction({
        reference: captured.wompi_reference,
        amountInCents: amount,
        currency: captured.currency,
        billingEmail: captured.billing_email,
        sourceId: captured.wompi_source_id,
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
      return; // POST alone is not settlement evidence; a mismatched response cannot select another User.
    }
    const candidate = created.value.transactionId;
    yield* attempt(() =>
      environment.DB.prepare(`INSERT OR IGNORE INTO billing_transaction_candidates
      (transaction_id, attempt_id) VALUES (?, ?)`)
        .bind(candidate, attemptId)
        .run()
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
  input: Readonly<{ environment: BillingRuntime; payload: unknown; activity: CollectionActivity }>
): Promise<void> => {
  const work = Schema.decodeUnknownOption(Schema.Union([CollectionMessage, LookupWork]))(
    input.payload
  );
  if (Option.isNone(work)) return Promise.resolve();
  const options = { retries: { limit: 0, delay: "1 second" } } as const;
  if ("kind" in work.value) {
    const transactionId = work.value.transactionId;
    return input.activity("lookup-wompi-billing-v1", options, () =>
      Effect.runPromise(reconcileEventCandidate(input.environment, transactionId))
    );
  }
  const attemptId = work.value.attemptId;
  return input.activity("collect-wompi-billing-v1", options, () =>
    Effect.runPromise(collect(input.environment, attemptId))
  );
};

export class BillingCollectionWorkflowV1 extends WorkflowEntrypoint<BillingRuntime, unknown> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return runBillingCollectionWorkflow({
      environment: this.env,
      payload: event.payload,
      activity: (name, options, activity) => step.do(name, options, activity),
    });
  }
}

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
    const fingerprint = Encoding.encodeHex(
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
    // Reserve the bounded lookup in D1 before the Activity can make outbound I/O.
    // A failed or ambiguous handoff consumes its reservation; support can renew a confirmed hint.
    const recorded = yield* attempt(() =>
      db.batch([
        db
          .prepare(
            "UPDATE billing_transaction_candidates SET last_checked_at_ms = ?, lookup_attempts = lookup_attempts + 1 WHERE transaction_id = ? AND lookup_attempts < ? AND (last_checked_at_ms IS NULL OR last_checked_at_ms < ?)"
          )
          .bind(now, transactionId, maximumCandidateLookupAttempts, now - candidateCooldownMs),
        db
          .prepare(
            "UPDATE billing_event_candidates SET last_checked_at_ms = ?, lookup_attempts = lookup_attempts + 1 WHERE transaction_id = ? AND lookup_attempts < ? AND resolved_at_ms IS NULL AND (last_checked_at_ms IS NULL OR last_checked_at_ms < ?)"
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
        FROM billing_transaction_candidates AS c
        JOIN billing_attempts AS a ON a.id = c.attempt_id WHERE a.status = 'pending'
          AND c.lookup_attempts < ?
          AND (c.last_checked_at_ms IS NULL OR c.last_checked_at_ms < ?)
      UNION
      SELECT c.transaction_id, COALESCE(c.last_checked_at_ms, c.received_at_ms) AS priority,
        c.signed_at, c.signed_status FROM billing_event_candidates AS c
        LEFT JOIN billing_transaction_evidence AS e ON e.transaction_id = c.transaction_id
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
