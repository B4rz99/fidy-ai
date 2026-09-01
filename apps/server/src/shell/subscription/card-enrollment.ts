import { Crypto, Data, DateTime, Effect, Encoding, Option, type Redacted } from "effect";
import type { UserId } from "~/core/identity/reference";
import {
  BillingEmail,
  type CardEnrollment,
  CardEnrollmentId,
  CardPaymentSourceId,
  RecurringDisclosure,
  type WompiSourceId,
} from "~/core/subscription/enrollment-model";
import {
  decideEnrollmentPreparation,
  decideEnrollmentSubmission,
} from "~/core/subscription/enrollment-rules";
import type { Price } from "~/core/subscription/model";
import type { PriceId } from "~/core/subscription/reference";
import { getVerifiedEmailInScope } from "~/shell/email-authentication/credential";
import { advisoryLockKey, withUserLockInScope } from "~/shell/db/advisory-lock";
import { withUserTransaction } from "~/shell/db/user-transaction";
import {
  type EnrollmentRecord,
  beginEnrollmentSubmissionInScope,
  contractEvidenceFromRecord,
  disclosureFromRecord,
  expireEnrollmentInScope,
  findAvailableEnrollmentInScope,
  findEnrollmentInScope,
  findPaymentSourceInScope,
  findPendingEnrollmentInScope,
  hasEnrollmentPreparationCapacityInScope,
  hasSourceCreationCapacityInScope,
  insertPreparedEnrollmentInScope,
  reconcileAvailableEnrollmentInScope,
  reconcileRefusedEnrollmentInScope,
  refuseEnrollmentInScope,
  retainAvailableSourceInScope,
  reusePaymentSourceInScope,
  verifyEnrollmentInScope,
} from "./enrollment-repo";
import { findPrice } from "./repo";
import { type WompiCardToken, type WompiContracts, WompiEnrollmentClient } from "./wompi-client";

const enrollmentLifetimeMinutes = 15;

export class CardEnrollmentInvalid extends Data.TaggedError("CardEnrollmentInvalid")<{}> {}
export class CardEnrollmentUnavailable extends Data.TaggedError("CardEnrollmentUnavailable")<{}> {}

export type SubmitCardEnrollment =
  | Readonly<{
      paymentSourceMode: "create";
      enrollmentId: CardEnrollmentId;
      billingEmail: BillingEmail;
      cardToken: Redacted.Redacted<WompiCardToken>;
    }>
  | Readonly<{
      paymentSourceMode: "reuse";
      enrollmentId: CardEnrollmentId;
      billingEmail: BillingEmail;
    }>;

const digestText = Effect.fn(function* (text: string) {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(Effect.orDie);
  return Encoding.encodeHex(bytes);
});

const makeDisclosure = Effect.fn(function* () {
  const displayedText = "Autorizo los cobros recurrentes de mi suscripción.";
  return RecurringDisclosure.make({
    revision: "wompi-card-enrollment-v1",
    displayedText,
    contentSha256: yield* digestText(displayedText),
  });
});

const projectEnrollment = (
  record: EnrollmentRecord,
  price: Price,
  wompiPublicKey: string
): CardEnrollment => {
  switch (record.status) {
    case "prepared":
      return {
        status: "prepared",
        enrollmentId: record.id,
        price,
        billingEmail: record.billingEmail,
        contracts: contractEvidenceFromRecord(record),
        recurringDisclosure: disclosureFromRecord(record),
        wompiPublicKey,
        paymentSourceMode: record.paymentSourceMode,
        expiresAt: record.expiresAt,
      };
    case "creating":
      return { status: "creating", enrollmentId: record.id, priceId: record.priceId };
    case "available":
      return { status: "available", enrollmentId: record.id, priceId: record.priceId };
    case "expired":
      return { status: "expired", enrollmentId: record.id, priceId: record.priceId };
    case "verifying":
      return { status: "verifying", enrollmentId: record.id, priceId: record.priceId };
    case "refused":
      return {
        status: "refused",
        enrollmentId: record.id,
        priceId: record.priceId,
        reason: record.refusalReason ?? "provider-error",
      };
  }
};

const loadEnrollment = Effect.fn(function* (
  userId: UserId,
  enrollmentId: CardEnrollmentId,
  publicKey: string
) {
  return yield* withUserTransaction(
    userId,
    Effect.gen(function* () {
      const record = yield* findEnrollmentInScope(userId, enrollmentId);
      if (Option.isNone(record)) return yield* new CardEnrollmentInvalid();
      const price = yield* findPrice(record.value.priceId);
      if (Option.isNone(price)) return yield* Effect.die("retained enrollment Price is missing");
      return projectEnrollment(record.value, price.value, publicKey);
    })
  );
});

/** Returns one User-owned enrollment status without exposing provider source identity. */
export const getCardEnrollment = Effect.fn("Subscription.getCardEnrollment")(function* (
  userId: UserId,
  enrollmentId: CardEnrollmentId
) {
  const wompi = yield* WompiEnrollmentClient;
  return yield* loadEnrollment(userId, enrollmentId, wompi.publicKey);
});

const canUseExisting = (record: EnrollmentRecord, requestedPriceId: PriceId): boolean => {
  switch (decideEnrollmentPreparation(record, requestedPriceId)._tag) {
    case "Observe":
      return true;
    case "ReauthorizeSource":
    case "ReplaceIntent":
    case "RestartRequired":
      return false;
  }
};

const matchingPendingEnrollment = (
  pending: Option.Option<EnrollmentRecord>,
  requestedPriceId: PriceId,
  preparedAt: DateTime.Utc
): Option.Option<EnrollmentRecord> =>
  Option.filter(
    pending,
    (record) =>
      !(record.status === "prepared" && DateTime.Order(preparedAt, record.expiresAt) >= 0) &&
      canUseExisting(record, requestedPriceId)
  );

const findExistingEnrollment = Effect.fn(function* ({
  userId,
  requestedPriceId,
  preparedAt,
  publicKey,
}: Readonly<{
  userId: UserId;
  requestedPriceId: PriceId;
  preparedAt: DateTime.Utc;
  publicKey: string;
}>) {
  const pending = matchingPendingEnrollment(
    yield* findPendingEnrollmentInScope(userId),
    requestedPriceId,
    preparedAt
  );
  const existing = Option.isSome(pending)
    ? pending
    : Option.filter(yield* findAvailableEnrollmentInScope(userId), (record) =>
        canUseExisting(record, requestedPriceId)
      );
  if (Option.isNone(existing)) return Option.none<CardEnrollment>();
  const price = yield* findPrice(existing.value.priceId);
  if (Option.isNone(price)) return yield* Effect.die("retained enrollment Price is missing");
  return Option.some(projectEnrollment(existing.value, price.value, publicKey));
});

/** Prepares or observes one replay-safe disclosure intent for the selected immutable Price. */
export const prepareCardEnrollment = Effect.fn(function* (
  userId: UserId,
  requestedPriceId: PriceId,
  preparedAt: DateTime.Utc
) {
  const wompi = yield* WompiEnrollmentClient;
  return yield* withUserTransaction(
    userId,
    withUserLockInScope(
      advisoryLockKey.subscriptionEnrollment(userId),
      Effect.gen(function* () {
        const selectedPrice = yield* findPrice(requestedPriceId);
        if (Option.isNone(selectedPrice)) return yield* new CardEnrollmentInvalid();
        const existing = yield* findExistingEnrollment({
          userId,
          requestedPriceId,
          preparedAt,
          publicKey: wompi.publicKey,
        });
        if (Option.isSome(existing)) return existing.value;
        if (!(yield* hasEnrollmentPreparationCapacityInScope(userId, preparedAt))) {
          return yield* new CardEnrollmentUnavailable();
        }

        const contracts = yield* wompi
          .contracts(preparedAt)
          .pipe(Effect.mapError(() => new CardEnrollmentUnavailable()));
        const crypto = yield* Crypto.Crypto;
        const enrollmentId = CardEnrollmentId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
        const verified = yield* getVerifiedEmailInScope(userId);
        const paymentSource = yield* findPaymentSourceInScope(userId);
        const disclosure = yield* makeDisclosure();
        yield* insertPreparedEnrollmentInScope({
          userId,
          enrollmentId,
          priceId: requestedPriceId,
          billingEmail: BillingEmail.make(verified.email),
          paymentSourceMode: Option.isSome(paymentSource) ? "reuse" : "create",
          contracts: contracts.evidence,
          disclosure,
          preparedAt,
          expiresAt: DateTime.add(preparedAt, { minutes: enrollmentLifetimeMinutes }),
        });
        const inserted = yield* findEnrollmentInScope(userId, enrollmentId);
        if (Option.isNone(inserted)) return yield* Effect.die("prepared enrollment missing");
        return projectEnrollment(inserted.value, selectedPrice.value, wompi.publicKey);
      })
    )
  ).pipe(
    Effect.tap((enrollment) => Effect.annotateCurrentSpan("enrollment.status", enrollment.status)),
    Effect.withSpan("Subscription.prepareCardEnrollment")
  );
});

const acceptanceTermsMatch = (record: EnrollmentRecord, current: WompiContracts): boolean => {
  const retained = contractEvidenceFromRecord(record);
  return (
    retained.endUserPolicy.permalink.href === current.evidence.endUserPolicy.permalink.href &&
    retained.endUserPolicy.contentSha256 === current.evidence.endUserPolicy.contentSha256 &&
    retained.endUserPolicy.providerContentHash ===
      current.evidence.endUserPolicy.providerContentHash &&
    retained.personalDataAuthorization.permalink.href ===
      current.evidence.personalDataAuthorization.permalink.href &&
    retained.personalDataAuthorization.contentSha256 ===
      current.evidence.personalDataAuthorization.contentSha256 &&
    retained.personalDataAuthorization.providerContentHash ===
      current.evidence.personalDataAuthorization.providerContentHash
  );
};

const beginSubmission = Effect.fn(function* (
  userId: UserId,
  input: SubmitCardEnrollment,
  acceptedAt: DateTime.Utc
) {
  return yield* withUserTransaction(
    userId,
    withUserLockInScope(
      advisoryLockKey.subscriptionEnrollment(userId),
      Effect.gen(function* () {
        const record = yield* findEnrollmentInScope(userId, input.enrollmentId);
        if (Option.isNone(record)) return yield* new CardEnrollmentInvalid();
        if (record.value.paymentSourceMode !== input.paymentSourceMode) {
          return yield* new CardEnrollmentInvalid();
        }
        switch (decideEnrollmentSubmission(record.value, acceptedAt)._tag) {
          case "ReturnCurrentStatus":
            return false;
          case "RecordExpiration":
            yield* expireEnrollmentInScope(userId, input.enrollmentId, acceptedAt);
            return false;
          case "BeginSubmission":
            if (
              input.paymentSourceMode === "create" &&
              !(yield* hasSourceCreationCapacityInScope(userId, acceptedAt))
            ) {
              return yield* new CardEnrollmentUnavailable();
            }
            return yield* beginEnrollmentSubmissionInScope({
              userId,
              enrollmentId: input.enrollmentId,
              billingEmail: input.billingEmail,
              acceptedAt,
            });
        }
      })
    )
  );
});

const createAndSavePaymentSource = Effect.fn(function* ({
  userId,
  input,
  contracts,
  acceptedAt,
}: Readonly<{
  userId: UserId;
  input: Extract<SubmitCardEnrollment, { paymentSourceMode: "create" }>;
  contracts: WompiContracts;
  acceptedAt: DateTime.Utc;
}>) {
  const wompi = yield* WompiEnrollmentClient;
  const providerResult = yield* wompi
    .createPaymentSource({
      cardToken: input.cardToken,
      billingEmail: input.billingEmail,
      contracts,
    })
    .pipe(Effect.result);
  if (providerResult._tag === "Failure") {
    yield* withUserTransaction(
      userId,
      providerResult.failure.certainty === "ambiguous"
        ? verifyEnrollmentInScope(userId, input.enrollmentId)
        : refuseEnrollmentInScope(userId, input.enrollmentId, "provider-error")
    );
    return;
  }
  if (providerResult.success._tag === "Refused") {
    yield* withUserTransaction(
      userId,
      refuseEnrollmentInScope(userId, input.enrollmentId, "provider-declined")
    );
    return;
  }
  const crypto = yield* Crypto.Crypto;
  const paymentSourceId = CardPaymentSourceId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
  yield* withUserTransaction(
    userId,
    retainAvailableSourceInScope({
      userId,
      enrollmentId: input.enrollmentId,
      paymentSourceId,
      wompiSourceId: providerResult.success.sourceId,
      createdAt: acceptedAt,
    })
  );
});

/**
 * Resolves a fenced ambiguous response after an operator verifies the outcome in Wompi. This seam is
 * deliberately server-only: provider source identity never enters a browser or canonical operation.
 */
export const reconcileCardEnrollment = Effect.fn("Subscription.reconcileCardEnrollment")(function* (
  input: Readonly<{
    userId: UserId;
    enrollmentId: CardEnrollmentId;
    outcome:
      | Readonly<{ _tag: "Refused" }>
      | Readonly<{ _tag: "Available"; sourceId: WompiSourceId }>;
    reconciledAt: DateTime.Utc;
  }>
) {
  const { enrollmentId, outcome, reconciledAt, userId } = input;
  const wompi = yield* WompiEnrollmentClient;
  if (outcome._tag === "Available") {
    const enrollment = yield* withUserTransaction(
      userId,
      findEnrollmentInScope(userId, enrollmentId)
    );
    if (Option.isNone(enrollment) || enrollment.value.status !== "verifying") {
      return yield* new CardEnrollmentInvalid();
    }
    const verified = yield* wompi
      .verifyPaymentSource(outcome.sourceId)
      .pipe(Effect.mapError(() => new CardEnrollmentInvalid()));
    if (
      verified.sourceId !== outcome.sourceId ||
      verified.billingEmail !== enrollment.value.billingEmail
    ) {
      return yield* new CardEnrollmentInvalid();
    }
  }
  return yield* withUserTransaction(
    userId,
    withUserLockInScope(
      advisoryLockKey.subscriptionEnrollment(userId),
      Effect.gen(function* () {
        if (outcome._tag === "Refused") {
          if (!(yield* reconcileRefusedEnrollmentInScope(userId, enrollmentId))) {
            return yield* new CardEnrollmentInvalid();
          }
          return;
        }
        const crypto = yield* Crypto.Crypto;
        const paymentSourceId = CardPaymentSourceId.make(
          yield* crypto.randomUUIDv7.pipe(Effect.orDie)
        );
        if (
          !(yield* reconcileAvailableEnrollmentInScope({
            userId,
            enrollmentId,
            paymentSourceId,
            wompiSourceId: outcome.sourceId,
            reconciledAt,
          }))
        ) {
          return yield* new CardEnrollmentInvalid();
        }
      })
    )
  );
});

/** Claims and settles one submission; no path can create a Wompi payment source twice. */
export const submitCardEnrollment = Effect.fn(function* (
  userId: UserId,
  input: SubmitCardEnrollment,
  acceptedAt: DateTime.Utc
) {
  return yield* Effect.gen(function* () {
    const wompi = yield* WompiEnrollmentClient;
    const began = yield* beginSubmission(userId, input, acceptedAt);
    if (!began) return yield* loadEnrollment(userId, input.enrollmentId, wompi.publicKey);
    const record = yield* withUserTransaction(
      userId,
      Effect.flatMap(findEnrollmentInScope(userId, input.enrollmentId), (found) =>
        Option.match(found, {
          onNone: () => Effect.die("started enrollment submission is missing"),
          onSome: Effect.succeed,
        })
      )
    );
    const freshAcceptanceTerms = yield* wompi.contracts(acceptedAt).pipe(Effect.result);
    if (freshAcceptanceTerms._tag === "Failure") {
      yield* withUserTransaction(
        userId,
        refuseEnrollmentInScope(userId, input.enrollmentId, "provider-error")
      );
      return yield* loadEnrollment(userId, input.enrollmentId, wompi.publicKey);
    }
    if (!acceptanceTermsMatch(record, freshAcceptanceTerms.success)) {
      yield* withUserTransaction(
        userId,
        refuseEnrollmentInScope(userId, input.enrollmentId, "terms-changed")
      );
      return yield* loadEnrollment(userId, input.enrollmentId, wompi.publicKey);
    }
    if (input.paymentSourceMode === "reuse") {
      yield* withUserTransaction(
        userId,
        Effect.gen(function* () {
          const paymentSource = yield* findPaymentSourceInScope(userId);
          if (Option.isNone(paymentSource)) {
            return yield* Effect.die("reusable payment source is missing");
          }
          yield* reusePaymentSourceInScope(userId, input.enrollmentId, paymentSource.value.id);
        })
      );
      return yield* loadEnrollment(userId, input.enrollmentId, wompi.publicKey);
    }
    yield* createAndSavePaymentSource({
      userId,
      input,
      contracts: freshAcceptanceTerms.success,
      acceptedAt,
    });
    return yield* loadEnrollment(userId, input.enrollmentId, wompi.publicKey);
  }).pipe(
    Effect.tap((enrollment) => Effect.annotateCurrentSpan("enrollment.status", enrollment.status)),
    Effect.withSpan("Subscription.submitCardEnrollment")
  );
});
