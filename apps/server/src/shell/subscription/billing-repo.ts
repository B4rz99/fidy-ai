import { type DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { IanaTimeZone } from "~/core/_shared/context";
import { Money, encodeMoneyAmount } from "~/core/_shared/money";
import { UserId } from "~/core/identity/reference";
import {
  BillingAttempt,
  BillingAttemptId,
  type BillingAttempt as BillingAttemptType,
  BillingPeriod,
  PaymentRequestId,
  Price,
  SubscriptionId,
  TaxTreatment,
  type WompiBillingStatus,
  WompiEnvironment,
  WompiTransactionId,
  WompiTransactionReference,
} from "~/core/subscription/model";
import type { PaidPeriodWindow } from "~/core/subscription/billing-rules";
import {
  CardEnrollmentId,
  CardPaymentSourceId,
  WompiSourceId,
} from "~/core/subscription/enrollment-model";
import { PriceId } from "~/core/subscription/reference";

const WompiSourceIdFromDb = Schema.FiniteFromString.pipe(Schema.decodeTo(WompiSourceId));

const BillingAttemptRow = Schema.Struct({
  id: BillingAttemptId,
  subscriptionId: SubscriptionId,
  paymentRequestId: PaymentRequestId,
  cardEnrollmentId: CardEnrollmentId,
  paymentSourceId: CardPaymentSourceId,
  wompiSourceId: WompiSourceIdFromDb,
  priceId: PriceId,
  amount: Money.fields.amount,
  currency: Money.fields.currency,
  billingPeriod: BillingPeriod,
  serviceMarket: Price.fields.serviceMarket,
  taxTreatment: TaxTreatment,
  timeZone: IanaTimeZone,
  wompiEnvironment: WompiEnvironment,
  wompiTransactionReference: WompiTransactionReference,
  wompiTransactionId: Schema.NullOr(WompiTransactionId),
  status: Schema.Literals(["pending", "failed", "succeeded"]),
  chargeState: Schema.Literals(["queued", "armed"]),
  createdAt: Schema.DateTimeUtcFromDate,
  armedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  failedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  finalizedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  paidPeriodEndsAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  renewalAnchor: Schema.NullOr(Schema.DateTimeUtcFromDate),
});
export type BillingAttemptRecord = typeof BillingAttemptRow.Type;

const billingAttemptColumns = `attempt.id, attempt.subscription_id AS "subscriptionId",
  attempt.payment_request_id AS "paymentRequestId",
  attempt.card_enrollment_id AS "cardEnrollmentId",
  attempt.payment_source_id AS "paymentSourceId", source.wompi_source_id AS "wompiSourceId",
  attempt.price_id AS "priceId",
  attempt.amount, attempt.currency, attempt.billing_period AS "billingPeriod",
  attempt.service_market AS "serviceMarket", attempt.tax_treatment AS "taxTreatment",
  attempt.time_zone AS "timeZone", attempt.wompi_environment AS "wompiEnvironment",
  attempt.wompi_transaction_reference AS "wompiTransactionReference",
  attempt.wompi_transaction_id AS "wompiTransactionId", attempt.status,
  attempt.charge_state AS "chargeState", attempt.created_at AS "createdAt",
  attempt.armed_at AS "armedAt", attempt.failed_at AS "failedAt",
  attempt.finalized_at AS "finalizedAt", period.ends_at AS "paidPeriodEndsAt",
  period.renewal_anchor AS "renewalAnchor"`;

/** Finds a User-owned BillingAttempt by one browser payment request. */
export const findBillingAttemptByRequestInScope = Effect.fn(
  "Subscription.findBillingAttemptByRequestInScope"
)(function* (userId: UserId, paymentRequestId: PaymentRequestId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: BillingAttemptRow,
    execute: () => sql`
      SELECT ${sql.literal(billingAttemptColumns)} FROM billing_attempts AS attempt
      INNER JOIN card_payment_sources AS source ON source.id = attempt.payment_source_id
      LEFT JOIN paid_subscription_periods AS period ON period.billing_attempt_id = attempt.id
      WHERE attempt.user_id = ${userId} AND attempt.payment_request_id = ${paymentRequestId}
    `,
  })(undefined).pipe(Effect.orDie);
});

/** Finds the one unsettled charge admitted for a User's Subscription. */
export const findPendingBillingAttemptInScope = Effect.fn(
  "Subscription.findPendingBillingAttemptInScope"
)(function* (userId: UserId, subscriptionId: SubscriptionId, priceId: PriceId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: BillingAttemptRow,
    execute: () => sql`
      SELECT ${sql.literal(billingAttemptColumns)} FROM billing_attempts AS attempt
      INNER JOIN card_payment_sources AS source ON source.id = attempt.payment_source_id
      LEFT JOIN paid_subscription_periods AS period ON period.billing_attempt_id = attempt.id
      WHERE attempt.user_id = ${userId} AND attempt.subscription_id = ${subscriptionId}
        AND attempt.price_id = ${priceId} AND attempt.status = 'pending'
    `,
  })(undefined).pipe(Effect.orDie);
});

/** Finds one queued User-owned BillingAttempt by its durable identity. */
export const findBillingAttemptByIdInScope = Effect.fn(
  "Subscription.findBillingAttemptByIdInScope"
)(function* (userId: UserId, billingAttemptId: BillingAttemptId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: BillingAttemptRow,
    execute: () => sql`
      SELECT ${sql.literal(billingAttemptColumns)} FROM billing_attempts AS attempt
      INNER JOIN card_payment_sources AS source ON source.id = attempt.payment_source_id
      LEFT JOIN paid_subscription_periods AS period ON period.billing_attempt_id = attempt.id
      WHERE attempt.user_id = ${userId} AND attempt.id = ${billingAttemptId}
    `,
  })(undefined).pipe(Effect.orDie);
});

/** Finds a User-owned BillingAttempt by provider correlation reference. */
export const findBillingAttemptByReferenceInScope = Effect.fn(
  "Subscription.findBillingAttemptByReferenceInScope"
)(function* (userId: UserId, reference: WompiTransactionReference) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: BillingAttemptRow,
    execute: () => sql`
      SELECT ${sql.literal(billingAttemptColumns)} FROM billing_attempts AS attempt
      INNER JOIN card_payment_sources AS source ON source.id = attempt.payment_source_id
      LEFT JOIN paid_subscription_periods AS period ON period.billing_attempt_id = attempt.id
      WHERE attempt.user_id = ${userId} AND attempt.wompi_transaction_reference = ${reference}
      FOR UPDATE OF attempt
    `,
  })(undefined).pipe(Effect.orDie);
});

const BillingContext = Schema.Struct({
  subscriptionId: SubscriptionId,
  timeZone: IanaTimeZone,
  paymentSourceId: CardPaymentSourceId,
  wompiSourceId: WompiSourceIdFromDb,
});

/** Loads only server-owned charge context for one available enrollment. */
export const getBillingContextInScope = Effect.fn("Subscription.getBillingContextInScope")(
  function* (userId: UserId, enrollmentId: CardEnrollmentId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: BillingContext,
      execute: () => sql`
        SELECT subscription.id AS "subscriptionId", users.time_zone AS "timeZone",
          source.id AS "paymentSourceId", source.wompi_source_id AS "wompiSourceId"
        FROM card_enrollments AS enrollment
        INNER JOIN card_payment_sources AS source
          ON source.id = enrollment.payment_source_id AND source.user_id = enrollment.user_id
        INNER JOIN subscriptions AS subscription ON subscription.user_id = enrollment.user_id
        INNER JOIN users ON users.id = enrollment.user_id
        WHERE enrollment.user_id = ${userId} AND enrollment.id = ${enrollmentId}
          AND enrollment.status = 'available' AND source.status = 'available'
      `,
    })(undefined).pipe(Effect.orDie);
  }
);

/** Inserts one immutable pending BillingAttempt; User/request uniqueness remains the replay fence. */
export const insertPendingBillingAttemptInScope = Effect.fn(
  "Subscription.insertPendingBillingAttemptInScope"
)(function* (input: {
  userId: UserId;
  billingAttemptId: BillingAttemptId;
  subscriptionId: SubscriptionId;
  paymentRequestId: PaymentRequestId;
  enrollmentId: CardEnrollmentId;
  paymentSourceId: CardPaymentSourceId;
  price: Price;
  timeZone: IanaTimeZone;
  wompiEnvironment: WompiEnvironment;
  reference: WompiTransactionReference;
  createdAt: DateTime.Utc;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO billing_attempts (
      id, user_id, subscription_id, payment_request_id, card_enrollment_id,
      payment_source_id, price_id, amount, currency, billing_period, service_market,
      tax_treatment, time_zone, wompi_environment, wompi_transaction_reference,
      status, charge_state, created_at
    ) VALUES (
      ${input.billingAttemptId}, ${input.userId}, ${input.subscriptionId},
      ${input.paymentRequestId}, ${input.enrollmentId}, ${input.paymentSourceId},
      ${input.price.id}, ${encodeMoneyAmount(input.price.money.amount)},
      ${input.price.money.currency}, ${input.price.billingPeriod}, ${input.price.serviceMarket},
      ${input.price.taxTreatment}, ${input.timeZone}, ${input.wompiEnvironment},
      ${input.reference}, 'pending', 'queued', ${input.createdAt}
    )
    ON CONFLICT DO NOTHING
  `.pipe(Effect.orDie);
});

const ArmedCharge = Schema.Struct({
  billingAttemptId: BillingAttemptId,
  reference: WompiTransactionReference,
  amount: Money.fields.amount,
  currency: Money.fields.currency,
  billingEmail: Schema.String,
  wompiSourceId: WompiSourceIdFromDb,
});
export type ArmedCharge = typeof ArmedCharge.Type;

/** Arms one provider mutation exactly once and returns its private server-owned input. */
export const armBillingAttemptInScope = Effect.fn("Subscription.armBillingAttemptInScope")(
  function* (userId: UserId, billingAttemptId: BillingAttemptId, armedAt: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: ArmedCharge,
      execute: () => sql`
        UPDATE billing_attempts AS attempt SET charge_state = 'armed', armed_at = ${armedAt}
        FROM card_payment_sources AS source, card_enrollments AS enrollment
        WHERE attempt.id = ${billingAttemptId} AND attempt.user_id = ${userId}
          AND attempt.charge_state = 'queued' AND attempt.status = 'pending'
          AND source.id = attempt.payment_source_id AND source.user_id = attempt.user_id
          AND enrollment.id = attempt.card_enrollment_id
        RETURNING attempt.id AS "billingAttemptId",
          attempt.wompi_transaction_reference AS reference, attempt.amount,
          attempt.currency, enrollment.billing_email AS "billingEmail",
          source.wompi_source_id AS "wompiSourceId"
      `,
    })(undefined).pipe(Effect.orDie);
  }
);

/** Retains a transaction identity only when the armed response matches its merchant reference. */
export const recordCreatedWompiTransactionInScope = Effect.fn(
  "Subscription.recordCreatedWompiTransactionInScope"
)(function* (input: {
  userId: UserId;
  billingAttemptId: BillingAttemptId;
  transactionId: WompiTransactionId;
  reference: WompiTransactionReference;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE billing_attempts SET wompi_transaction_id = ${input.transactionId}
    WHERE id = ${input.billingAttemptId} AND user_id = ${input.userId} AND charge_state = 'armed'
      AND wompi_transaction_reference = ${input.reference}
      AND (wompi_transaction_id IS NULL OR wompi_transaction_id = ${input.transactionId})
  `.pipe(Effect.orDie);
});

/** Resolves only the User identity after Wompi event authentication; reference possession is not authority. */
export const resolveWompiBillingUser = Effect.fn("Subscription.resolveWompiBillingUser")(function* (
  reference: WompiTransactionReference
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ userId: Schema.NullOr(UserId) }),
    execute: () => sql`
        SELECT fidy_resolve_wompi_billing_user(${reference}) AS "userId"
      `,
  })(undefined).pipe(Effect.orDie);
  return Option.fromNullOr(row.userId);
});

/** Resolves the User for an already retained, provider-authenticated transaction identity. */
export const resolveWompiBillingUserByTransaction = Effect.fn(
  "Subscription.resolveWompiBillingUserByTransaction"
)(function* (transactionId: WompiTransactionId) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ userId: Schema.NullOr(UserId) }),
    execute: () => sql`
      SELECT fidy_resolve_wompi_billing_user_by_transaction(${transactionId}) AS "userId"
    `,
  })(undefined).pipe(Effect.orDie);
  return Option.fromNullOr(row.userId);
});

/** Checks a completed authenticated observation before repeating provider reconciliation. */
export const hasWompiObservationInScope = Effect.fn("Subscription.hasWompiObservationInScope")(
  function* (userId: UserId, transactionId: WompiTransactionId, checksum: string) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
    SELECT 1 FROM wompi_billing_observations
    WHERE user_id = ${userId} AND wompi_transaction_id = ${transactionId}
      AND event_checksum = ${checksum}
    LIMIT 1
  `.pipe(Effect.orDie);
    return rows.length > 0;
  }
);

/** Appends an authenticated provider observation idempotently inside the owning User transaction. */
export const appendWompiObservationInScope = Effect.fn(
  "Subscription.appendWompiObservationInScope"
)(function* (input: {
  userId: UserId;
  billingAttemptId: BillingAttemptId;
  checksum: string;
  transactionId: WompiTransactionId;
  status: WompiBillingStatus;
  amountInCents: number;
  currency: string;
  wompiSourceId: WompiSourceId;
  wompiEnvironment: WompiEnvironment;
  finalizedAt: Option.Option<DateTime.Utc>;
  observedAt: DateTime.Utc;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO wompi_billing_observations (
      user_id, billing_attempt_id, event_checksum, wompi_transaction_id, status,
      amount_in_cents, currency, wompi_source_id, wompi_environment, finalized_at, observed_at
    ) VALUES (
      ${input.userId}, ${input.billingAttemptId}, ${input.checksum}, ${input.transactionId},
      ${input.status}, ${input.amountInCents}, ${input.currency}, ${input.wompiSourceId},
      ${input.wompiEnvironment}, ${Option.getOrNull(input.finalizedAt)}, ${input.observedAt}
    ) ON CONFLICT (billing_attempt_id, event_checksum) DO NOTHING
  `.pipe(Effect.orDie);
});

/** Records a verified negative outcome without changing Subscription standing. */
export const failBillingAttemptInScope = Effect.fn("Subscription.failBillingAttemptInScope")(
  function* (userId: UserId, billingAttemptId: BillingAttemptId, failedAt: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE billing_attempts SET status = 'failed', failed_at = ${failedAt}, finalized_at = NULL
      WHERE id = ${billingAttemptId} AND user_id = ${userId} AND status = 'pending'
    `.pipe(Effect.orDie);
  }
);

/** Atomically marks success and inserts the paid period identified by the BillingAttempt. */
export const activatePaidPeriodInScope = Effect.fn("Subscription.activatePaidPeriodInScope")(
  function* (input: {
    userId: UserId;
    attempt: BillingAttemptRecord;
    period: PaidPeriodWindow;
    transactionId: WompiTransactionId;
    recordedAt: DateTime.Utc;
  }) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE billing_attempts SET status = 'succeeded', failed_at = NULL,
        finalized_at = ${input.period.startsAt},
        wompi_transaction_id = COALESCE(wompi_transaction_id, ${input.transactionId})
      WHERE id = ${input.attempt.id} AND user_id = ${input.userId}
        AND status IN ('pending', 'failed')
    `.pipe(Effect.orDie);
    yield* sql`
      INSERT INTO paid_subscription_periods (
        billing_attempt_id, user_id, subscription_id, starts_at, ends_at, renewal_anchor, created_at
      ) VALUES (
        ${input.attempt.id}, ${input.userId}, ${input.attempt.subscriptionId},
        ${input.period.startsAt}, ${input.period.endsAt}, ${input.period.renewalAnchor},
        ${input.recordedAt}
      ) ON CONFLICT (billing_attempt_id) DO NOTHING
    `.pipe(Effect.orDie);
  }
);

/** Projects one trusted relational BillingAttempt without any private provider references. */
export const projectBillingAttempt = (record: BillingAttemptRecord): BillingAttemptType => {
  const snapshot = {
    id: record.id,
    priceId: record.priceId,
    money: Money.make({ amount: record.amount, currency: record.currency }),
    billingPeriod: record.billingPeriod,
    serviceMarket: record.serviceMarket,
    taxTreatment: record.taxTreatment,
    timeZone: record.timeZone,
    createdAt: record.createdAt,
  };
  if (record.status === "pending") return BillingAttempt.make({ status: "pending", ...snapshot });
  if (record.status === "failed") {
    return BillingAttempt.make({
      status: "failed",
      ...snapshot,
      failedAt: Option.getOrThrow(Option.fromNullOr(record.failedAt)),
    });
  }
  return BillingAttempt.make({
    status: "succeeded",
    ...snapshot,
    finalizedAt: Option.getOrThrow(Option.fromNullOr(record.finalizedAt)),
    paidPeriodEndsAt: Option.getOrThrow(Option.fromNullOr(record.paidPeriodEndsAt)),
    renewalAnchor: Option.getOrThrow(Option.fromNullOr(record.renewalAnchor)),
  });
};
