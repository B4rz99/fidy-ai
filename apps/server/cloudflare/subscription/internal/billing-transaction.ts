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
import { WompiSourceId, type WompiTransactionId, WompiTransactionReference } from "./wompi-model";
import { amountInCentsForBilling } from "./billing-rules";
import { paidPeriodFor } from "../../../src/core/subscription/operations";
import { type VerifiedOutcome, recordVerifiedBillingEvidence } from "./billing-settlement";
import { Clock, DateTime, Effect, Exit, Option, Schema } from "effect";
import { type WompiTransportFactory } from "./wompi-runtime";
import { BillingCollectionFailure, type BillingRuntime } from "../contract";

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
const billingAmount = (
  captured: typeof Snapshot.Type
): Effect.Effect<number, BillingCollectionFailure> =>
  Effect.flatMap(decode(Money, { amount: captured.amount, currency: captured.currency }), (money) =>
    amountInCentsForBilling(money.amount)
  );
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
        FROM billing_attempt_context AS a JOIN payment_source_context AS s ON s.id = a.payment_source_id
        WHERE a.id = ? AND a.user_id = s.user_id`)
        .bind(id)
        .first()
    );
    return yield* decode(Snapshot, row);
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
          "SELECT id FROM billing_attempt_context WHERE wompi_reference = ? AND wompi_environment = ?"
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
const reconcileBillingTransaction = (
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

export const reconcileEventCandidate = (
  input: Readonly<{
    environment: BillingRuntime;
    transactionId: WompiTransactionId;
    wompiHttp: WompiTransportFactory;
    generation: Readonly<{ signedAt: Option.Option<number>; signedStatus: Option.Option<string> }>;
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const { environment, transactionId } = input;
    const client = yield* billingClient(environment, input.wompiHttp);
    yield* reconcileBillingTransaction({ db: environment.DB, client, transactionId });
    const now = yield* Clock.currentTimeMillis;
    yield* attempt(() =>
      environment.DB.prepare(`UPDATE billing_provider_transactions
      SET event_resolved_at_ms = ? WHERE transaction_id = ? AND event_received_at_ms IS NOT NULL AND event_resolved_at_ms IS NULL
      AND event_signed_at IS ? AND event_signed_status IS ?
      AND EXISTS (SELECT 1 FROM billing_provider_transactions AS e
        JOIN billing_attempt_context AS a ON a.id = e.attempt_id
        WHERE e.transaction_id = ? AND a.status IN ('succeeded', 'failed'))`)
        .bind(
          now,
          transactionId,
          Option.getOrNull(input.generation.signedAt),
          Option.getOrNull(input.generation.signedStatus),
          transactionId
        )
        .run()
    );
  }).pipe(Effect.withSpan("billing.collection.lookup"));

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
            AND EXISTS (SELECT 1 FROM billing_attempt_context due WHERE due.id=? AND
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

export const collectBillingTransaction = (
  input: Readonly<{
    environment: BillingRuntime;
    attemptId: BillingAttemptId;
    wompiHttp: WompiTransportFactory;
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const { environment, attemptId, wompiHttp } = input;
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
