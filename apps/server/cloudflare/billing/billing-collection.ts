import {
  BillingAttemptId,
  BillingEmail,
  IanaTimeZone,
  type WompiBillingClientService,
  WompiEnvironment,
  WompiSourceId,
  type WompiTransaction,
  WompiTransactionId,
  WompiTransactionReference,
  amountInCentsForBilling,
  makeWompiBillingClient,
  makeWompiOutboundHttp,
  paidPeriodFor,
} from "@fidy/server/subscription-runtime";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { recordVerifiedBillingEvidence } from "./billing-settlement";
import { verifiedWompiEventId } from "./wompi-event";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import {
  BigDecimal,
  Clock,
  Context,
  Crypto,
  Data,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

const Work = Schema.Struct({ version: Schema.Literal(1), attemptId: BillingAttemptId });
/** Identify this Queue payload without interpreting any provider data as authority. */
export const isBillingCollectionWork = (body: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(Work)(body));
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
const Candidate = Schema.Struct({ transaction_id: WompiTransactionId });
const pendingBatchSize = 32;
const dispatchCooldownMs = 60_000;
const candidateCooldownMs = 60_000;

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

const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, bytes) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle
          .digest(algorithm, new Uint8Array(bytes))
          .then((value) => new Uint8Array(value)),
      catch: () => undefined,
    }).pipe(Effect.orDie),
});

const billingClient = (
  environment: BillingRuntime
): Effect.Effect<WompiBillingClientService, BillingCollectionFailure> =>
  Effect.scoped(
    Effect.gen(function* () {
      const configured = yield* decode(WompiEnvironment, environment.WOMPI_ENVIRONMENT);
      const clients = yield* Layer.build(FetchHttpClient.layer).pipe(
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)
      );
      const outboundHttp = makeWompiOutboundHttp({
        environment: configured,
        publicKey: environment.WOMPI_PUBLIC_KEY,
        privateKey: Redacted.make(environment.WOMPI_PRIVATE_KEY),
        integritySecret: Redacted.make(environment.WOMPI_INTEGRITY_SECRET),
        httpClient: Context.get(clients, HttpClient.HttpClient),
        crypto: workerCrypto,
      });
      return makeWompiBillingClient({ outboundHttp, environment: configured });
    })
  );

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
    environment: Pick<BillingCollectionEnvironment, "DB" | "BILLING_COLLECTION_QUEUE">;
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
  environment: Pick<BillingCollectionEnvironment, "DB" | "BILLING_COLLECTION_QUEUE">
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* attempt(() =>
      environment.DB.prepare(`SELECT o.attempt_id, o.version
      FROM billing_collection_outbox AS o JOIN billing_collection_arms AS arm ON arm.attempt_id = o.attempt_id
      WHERE arm.state = 'armed' AND (o.last_attempt_at_ms IS NULL OR o.last_attempt_at_ms < ?)
      ORDER BY o.last_attempt_at_ms, o.attempt_id LIMIT ?`)
        .bind(now - dispatchCooldownMs, pendingBatchSize)
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
  });

/** Duplicated Queue messages converge on one deterministic Workflow instance. */
export const receiveBillingCollection = (
  input: Readonly<{
    environment: Pick<BillingCollectionEnvironment, "DB" | "BILLING_COLLECTION_WORKFLOW">;
    batch: MessageBatch<unknown>;
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    for (const message of input.batch.messages) {
      const work = Schema.decodeUnknownOption(Work)(message.body);
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
      if (row?.state !== "armed") {
        message.ack();
        continue;
      }
      const started = yield* Effect.exit(
        attempt(() =>
          input.environment.BILLING_COLLECTION_WORKFLOW.create({
            id: work.value.attemptId,
            params: work.value,
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
  });

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
    [input.found.sourceId, input.captured.wompi_source_id],
    [input.environment, input.captured.wompi_environment],
  ];
  return (
    facts.every(([observed, expected]) => observed === expected) &&
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
    const amount = yield* amountInCentsForBilling(BigDecimal.fromStringUnsafe(captured.amount));
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
    const finalizedAt = Option.map(found.finalizedAt, DateTime.toEpochMillis);
    const period =
      Option.isSome(found.finalizedAt) && found.status === "APPROVED"
        ? Option.some(
            yield* paidPeriodFor(
              captured.billing_period,
              captured.time_zone,
              found.finalizedAt.value
            )
          )
        : Option.none();
    const periodStart = Option.map(period, (value) => DateTime.toEpochMillis(value.startsAt));
    const periodEnd = Option.map(period, (value) => DateTime.toEpochMillis(value.endsAt));
    const renewalAnchor = Option.map(period, (value) =>
      DateTime.toEpochMillis(value.renewalAnchor)
    );
    yield* attempt(() =>
      recordVerifiedBillingEvidence({
        db: input.db,
        attemptId: captured.id,
        transactionId: input.transactionId,
        status: found.status,
        observedAtMs: now,
        finalizedAtMs: finalizedAt,
        periodStartMs: periodStart,
        periodEndMs: periodEnd,
        renewalAnchorMs: renewalAnchor,
      })
    );
  });

const reconcileEventCandidate = (
  input: Readonly<{
    db: D1Database;
    client: WompiBillingClientService;
    transactionId: WompiTransactionId;
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    yield* reconcileBillingTransaction(input);
    yield* attempt(() =>
      input.db
        .prepare("DELETE FROM billing_event_candidates WHERE transaction_id = ?")
        .bind(input.transactionId)
        .run()
    );
  });

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
      verifiedWompiEventId({
        request: input.request,
        secret: input.environment.WOMPI_EVENT_SECRET,
        environment: configured.value,
      })
    );
    if (Exit.isFailure(verified) || Option.isNone(verified.value)) {
      return new Response(null, { status: 400 });
    }
    const id = verified.value.value;
    const now = yield* Clock.currentTimeMillis;
    const retained = yield* Effect.exit(
      attempt(() =>
        input.environment.DB.prepare(`INSERT OR IGNORE INTO billing_event_candidates
      (transaction_id, received_at_ms) VALUES (?, ?)`)
          .bind(id, now)
          .run()
      )
    );
    if (Exit.isFailure(retained)) return new Response(null, { status: 503 });
    const client = yield* Effect.exit(billingClient(input.environment));
    if (Exit.isSuccess(client)) {
      yield* Effect.exit(
        reconcileEventCandidate({
          db: input.environment.DB,
          client: client.value,
          transactionId: id,
        })
      );
    }
    // The persisted hint is sufficient: a sweep retries authenticated GET without trusting the callback state.
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
    const amount = yield* amountInCentsForBilling(BigDecimal.fromStringUnsafe(captured.amount));
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
    if (Exit.isFailure(created)) return; // Retain ambiguity; do not rearm on timeout or malformed response.
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
  });

type CollectionActivity = (
  name: string,
  options: WorkflowStepConfig,
  run: () => Promise<void>
) => Promise<void>;

/** Only a versioned identity enters Workflow state. The named Activity owns the one armed POST. */
export const runBillingCollectionWorkflow = (
  input: Readonly<{ environment: BillingRuntime; payload: unknown; activity: CollectionActivity }>
): Promise<void> => {
  const work = Schema.decodeUnknownOption(Work)(input.payload);
  if (Option.isNone(work)) return Promise.resolve();
  return input.activity(
    "collect-wompi-billing-v1",
    { retries: { limit: 0, delay: "1 second" } },
    () => Effect.runPromise(collect(input.environment, work.value.attemptId))
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

/** Recheck known candidates and delay terminal negative settlement until the retry window expires. */
export const reconcileBillingCandidates = (
  environment: BillingRuntime
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* attempt(() =>
      environment.DB.prepare(`SELECT transaction_id FROM (
      SELECT c.transaction_id, COALESCE(c.last_checked_at_ms, a.created_at_ms) AS priority
        FROM billing_transaction_candidates AS c
        JOIN billing_attempts AS a ON a.id = c.attempt_id WHERE a.status <> 'succeeded'
          AND (c.last_checked_at_ms IS NULL OR c.last_checked_at_ms < ?)
      UNION
      SELECT transaction_id, COALESCE(last_checked_at_ms, received_at_ms) AS priority
        FROM billing_event_candidates
        WHERE last_checked_at_ms IS NULL OR last_checked_at_ms < ?
    ) ORDER BY priority LIMIT ?`)
        .bind(now - candidateCooldownMs, now - candidateCooldownMs, pendingBatchSize)
        .all()
    );
    const candidates = yield* decode(Schema.Array(Candidate), rows.results);
    if (candidates.length === 0) return;
    const client = yield* billingClient(environment);
    for (const candidate of candidates) {
      yield* attempt(() =>
        environment.DB.batch([
          environment.DB.prepare(
            "UPDATE billing_transaction_candidates SET last_checked_at_ms = ? WHERE transaction_id = ?"
          ).bind(now, candidate.transaction_id),
          environment.DB.prepare(
            "UPDATE billing_event_candidates SET last_checked_at_ms = ? WHERE transaction_id = ?"
          ).bind(now, candidate.transaction_id),
        ])
      );
      yield* Effect.exit(
        reconcileEventCandidate({
          db: environment.DB,
          client,
          transactionId: candidate.transaction_id,
        })
      );
    }
  });
