import { timingSafeEqual } from "node:crypto";
import {
  Config,
  Crypto,
  Data,
  DateTime,
  Effect,
  Encoding,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import {
  WompiBillingStatus,
  WompiEnvironment,
  WompiTransactionId,
  WompiTransactionReference,
} from "~/core/subscription/model";
import {
  amountInCentsForBilling,
  decideBillingAttemptOutcome,
  paidPeriodFor,
} from "~/core/subscription/billing-rules";
import { WompiSourceId } from "~/core/subscription/enrollment-model";
import type { UserId } from "~/core/identity/reference";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { configuredSecret } from "~/shell/_shared/configured-secret";
import { wompiCredentialPrefixes } from "./wompi-credentials";
import { activatePaidProInScope } from "./access-repo";
import { WompiBillingClient, type WompiTransaction } from "./wompi-billing-client";
import {
  type BillingAttemptRecord,
  activatePaidPeriodInScope,
  appendWompiObservationInScope,
  failBillingAttemptInScope,
  findBillingAttemptByReferenceInScope,
  hasWompiObservationInScope,
  recordCreatedWompiTransactionInScope,
  resolveWompiBillingUser,
  resolveWompiBillingUserByTransaction,
} from "./billing-repo";

const maximumSignedProperties = 16;
const settlementProperties = [
  "transaction.id",
  "transaction.status",
  "transaction.amount_in_cents",
] as const;
const EventSecret = Schema.String.check(
  Schema.isPattern(/^test_events_[A-Za-z0-9_-]{8,}$|^prod_events_[A-Za-z0-9_-]{8,}$/u)
);
const WompiEvent = Schema.Struct({
  event: Schema.Literal("transaction.updated"),
  data: Schema.Struct({
    transaction: Schema.Struct({
      id: WompiTransactionId,
      reference: WompiTransactionReference,
      status: WompiBillingStatus,
      amount_in_cents: Schema.Int,
      currency: Schema.String,
      payment_source_id: WompiSourceId,
      finalized_at: Schema.NullOr(Schema.DateTimeUtcFromString),
    }),
  }),
  timestamp: Schema.Int,
  signature: Schema.Struct({
    checksum: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
    properties: Schema.Array(Schema.String).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(maximumSignedProperties)
    ),
  }),
});
const decodeEvent = Schema.decodeUnknownResult(WompiEvent);
type Event = typeof WompiEvent.Type;
type Transaction = Event["data"]["transaction"];

export class InvalidWompiEvent extends Data.TaggedError("InvalidWompiEvent")<{}> {}
export class MismatchedWompiEvidence extends Data.TaggedError("MismatchedWompiEvidence")<{}> {}
export class WompiSettlementUnavailable extends Data.TaggedError(
  "WompiSettlementUnavailable"
)<{}> {}

const propertyValue = (event: Event, property: string): Option.Option<string> => {
  const transaction = event.data.transaction;
  switch (property) {
    case "transaction.id":
      return Option.some(transaction.id);
    case "transaction.status":
      return Option.some(transaction.status);
    case "transaction.amount_in_cents":
      return Option.some(String(transaction.amount_in_cents));
    default:
      return Option.none();
  }
};

const checksumMatches = Effect.fn(function* (event: Event, secret: Redacted.Redacted<string>) {
  const values = Option.all(
    event.signature.properties.map((property) => propertyValue(event, property))
  );
  if (Option.isNone(values)) return false;
  const crypto = yield* Crypto.Crypto;
  const expected = yield* crypto
    .digest(
      "SHA-256",
      new TextEncoder().encode(
        `${values.value.join("")}${event.timestamp}${Redacted.value(secret)}`
      )
    )
    .pipe(Effect.orDie);
  const actual = Encoding.decodeHex(event.signature.checksum);
  return (
    Result.isSuccess(actual) &&
    actual.success.length === expected.length &&
    timingSafeEqual(actual.success, expected)
  );
});

const authenticateEvent = Effect.fn("Subscription.authenticateWompiEvent")(function* (
  event: Event
) {
  const environment = yield* Config.schema(WompiEnvironment, "WOMPI_ENVIRONMENT");
  const eventSecretPrefix = wompiCredentialPrefixes(environment).eventSecret;
  const secret = yield* configuredSecret({
    name: "WOMPI_EVENT_SECRET",
    schema: EventSecret.check(Schema.isStartsWith(eventSecretPrefix)),
    requirement: `must be a ${environment} Wompi event secret`,
  });
  const checksumValid = yield* checksumMatches(event, secret);
  const signedProperties = new Set(event.signature.properties);
  if (
    signedProperties.size !== settlementProperties.length ||
    settlementProperties.some((property) => !signedProperties.has(property)) ||
    !checksumValid
  ) {
    return yield* new InvalidWompiEvent();
  }
  return environment;
});

const evidenceMatches = Effect.fn(function* (
  attempt: BillingAttemptRecord,
  transaction: Transaction,
  environment: WompiEnvironment
) {
  return (
    attempt.wompiEnvironment === environment &&
    (yield* amountInCentsForBilling(attempt.amount)) === transaction.amount_in_cents &&
    attempt.currency === transaction.currency &&
    attempt.wompiSourceId === transaction.payment_source_id &&
    (attempt.wompiTransactionId === null || attempt.wompiTransactionId === transaction.id)
  );
});

const applySettlementInScope = Effect.fn("Subscription.applyWompiSettlementInScope")(
  function* (input: {
    userId: UserId;
    event: Event;
    environment: WompiEnvironment;
    observedAt: DateTime.Utc;
  }) {
    const transaction = input.event.data.transaction;
    const found = yield* findBillingAttemptByReferenceInScope(input.userId, transaction.reference);
    if (Option.isNone(found)) return yield* new MismatchedWompiEvidence();
    const attempt = found.value;
    if (!(yield* evidenceMatches(attempt, transaction, input.environment))) {
      return yield* new MismatchedWompiEvidence();
    }
    yield* appendWompiObservationInScope({
      userId: input.userId,
      billingAttemptId: attempt.id,
      checksum: input.event.signature.checksum,
      transactionId: transaction.id,
      status: transaction.status,
      amountInCents: transaction.amount_in_cents,
      currency: transaction.currency,
      wompiSourceId: transaction.payment_source_id,
      wompiEnvironment: input.environment,
      finalizedAt: Option.fromNullOr(transaction.finalized_at),
      observedAt: input.observedAt,
    });
    // An authenticated observation that reveals the provider transaction id also satisfies the
    // awaiting-reference condition, so the operational marker clears with the retained identity.
    if (attempt.wompiTransactionId === null) {
      yield* recordCreatedWompiTransactionInScope({
        userId: input.userId,
        billingAttemptId: attempt.id,
        transactionId: transaction.id,
        reference: transaction.reference,
      });
    }
    const outcome = yield* decideBillingAttemptOutcome({
      current: attempt.status,
      observed: transaction.status,
    });
    if (outcome === attempt.status || outcome === "pending") return;
    if (outcome === "failed") {
      return yield* failBillingAttemptInScope(input.userId, attempt.id, input.observedAt);
    }
    if (transaction.finalized_at === null) return yield* new MismatchedWompiEvidence();
    const period = yield* paidPeriodFor(
      attempt.billingPeriod,
      attempt.timeZone,
      transaction.finalized_at
    );
    yield* activatePaidPeriodInScope({
      userId: input.userId,
      attempt,
      period,
      transactionId: transaction.id,
      recordedAt: input.observedAt,
    });
    yield* activatePaidProInScope(input.userId);
  }
);

const authoritativeEvent = (provider: WompiTransaction, observationId: string): Event => ({
  event: "transaction.updated",
  data: {
    transaction: {
      id: provider.transactionId,
      reference: provider.reference,
      status: provider.status,
      amount_in_cents: provider.amountInCents,
      currency: provider.currency,
      payment_source_id: provider.sourceId,
      finalized_at: Option.getOrNull(provider.finalizedAt),
    },
  },
  timestamp: 0,
  signature: { checksum: observationId, properties: [] },
});

/** Applies a credential-authenticated authoritative Wompi lookup without trusting an initial response. */
export const reconcileWompiSettlement = Effect.fn("Subscription.reconcileWompiSettlement")(
  function* (input: {
    provider: WompiTransaction;
    environment: WompiEnvironment;
    observedAt: DateTime.Utc;
  }) {
    const owner = yield* resolveWompiBillingUser(input.provider.reference);
    if (Option.isNone(owner)) return yield* new MismatchedWompiEvidence();
    yield* withUserTransaction(
      owner.value,
      applySettlementInScope({
        userId: owner.value,
        event: authoritativeEvent(
          input.provider,
          `lookup:${input.provider.transactionId}:${input.provider.status}:${DateTime.formatIso(input.observedAt)}`
        ),
        environment: input.environment,
        observedAt: input.observedAt,
      })
    );
  }
);

/** Authenticates and atomically applies one Wompi settlement observation. */
export const receiveWompiSettlement = Effect.fn("Subscription.receiveWompiSettlement")(
  function* (input: { readonly payload: unknown; readonly observedAt: DateTime.Utc }) {
    const decoded = decodeEvent(input.payload);
    if (Result.isFailure(decoded)) return yield* new InvalidWompiEvent();
    const event = decoded.success;
    const environment = yield* authenticateEvent(event);
    const knownOwner = yield* resolveWompiBillingUserByTransaction(event.data.transaction.id);
    if (
      Option.isSome(knownOwner) &&
      (yield* withUserTransaction(
        knownOwner.value,
        hasWompiObservationInScope(
          knownOwner.value,
          event.data.transaction.id,
          event.signature.checksum
        )
      ))
    ) {
      return;
    }
    const billing = yield* WompiBillingClient;
    const provider = yield* billing
      .findTransaction(event.data.transaction.id)
      .pipe(Effect.mapError(() => new WompiSettlementUnavailable()));
    if (
      provider.transactionId !== event.data.transaction.id ||
      provider.status !== event.data.transaction.status ||
      provider.amountInCents !== event.data.transaction.amount_in_cents
    ) {
      return yield* new MismatchedWompiEvidence();
    }
    const verifiedEvent = authoritativeEvent(provider, event.signature.checksum);
    const owner = yield* resolveWompiBillingUser(provider.reference);
    if (Option.isNone(owner)) return yield* new MismatchedWompiEvidence();
    yield* withUserTransaction(
      owner.value,
      applySettlementInScope({
        userId: owner.value,
        event: verifiedEvent,
        environment,
        observedAt: input.observedAt,
      })
    );
  }
);
