import { WompiEnvironment } from "../../../src/shell/secret-material/contract";
import {
  BillingAttemptId,
  BillingEmail,
  EnrollmentMethod,
} from "../../../src/core/subscription/contract";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { Money } from "../../../src/core/_shared/money";
import { type WompiTransaction } from "./wompi-billing-client";
import { WompiSourceId, type WompiTransactionId, WompiTransactionReference } from "./wompi-model";
import { amountInCentsForBilling } from "./billing-rules";
import { paidPeriodFor } from "../../../src/core/subscription/operations";
import { type VerifiedOutcome } from "./billing-settlement";
import { DateTime, Effect, Option, Schema } from "effect";
import { BillingCollectionFailure } from "../contract";

export const Snapshot = Schema.Struct({
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

export const billingAmount = (
  captured: typeof Snapshot.Type
): Effect.Effect<number, BillingCollectionFailure> =>
  Effect.flatMap(decode(Money, { amount: captured.amount, currency: captured.currency }), (money) =>
    amountInCentsForBilling(money.amount)
  );

const failure = (cause: Option.Option<unknown> = Option.none()): BillingCollectionFailure =>
  new BillingCollectionFailure({ cause });

const decode = <A, E>(
  schema: Schema.Codec<A, E>,
  value: unknown
): Effect.Effect<A, BillingCollectionFailure> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => failure(Option.some(cause)))
  );

export const matchesSnapshot = (
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

export const verifiedOutcome = Effect.fn(function* (
  captured: typeof Snapshot.Type,
  found: WompiTransaction
) {
  let settlement: VerifiedOutcome;

  if (found.status === "APPROVED") {
    if (Option.isNone(found.finalizedAt)) return yield* failure();

    const period = Option.isSome(captured.previous_paid_attempt_id)
      ? yield* Effect.fromOption(
          Option.all({ startsAt: captured.period_starts_at_ms, endsAt: captured.period_ends_at_ms })
        ).pipe(
          Effect.orDie,
          Effect.map(({ startsAt, endsAt }) => ({
            startsAt: DateTime.makeUnsafe(startsAt),
            endsAt: DateTime.makeUnsafe(endsAt),
            renewalAnchor: DateTime.makeUnsafe(endsAt),
          }))
        )
      : yield* paidPeriodFor(captured.billing_period, captured.time_zone, found.finalizedAt.value);

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

  return settlement;
});
