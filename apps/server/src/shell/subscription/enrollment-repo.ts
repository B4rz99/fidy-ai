import { type DateTime, Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";
import {
  BillingEmail,
  CardEnrollmentId,
  CardPaymentSourceId,
  RecurringDisclosure,
  type WompiContractEvidenceSet,
  type WompiSourceId,
} from "~/core/subscription/enrollment-model";
import { PriceId } from "~/core/subscription/reference";

const EnrollmentStatus = Schema.Literals([
  "prepared",
  "creating",
  "available",
  "refused",
  "expired",
  "verifying",
]);
const SourceMode = Schema.Literals(["create", "reuse"]);
const RefusalReason = Schema.Literals(["provider-declined", "provider-error", "terms-changed"]);
const SourceCreationCapacity = Schema.Struct({ available: Schema.Boolean });
const maximumEnrollmentPreparationsPerHour = 12;
const maximumSourceCreationAttemptsPerHour = 5;
const EnrollmentRow = Schema.Struct({
  id: CardEnrollmentId,
  priceId: PriceId,
  billingEmail: BillingEmail,
  paymentSourceMode: SourceMode,
  status: EnrollmentStatus,
  refusalReason: Schema.NullOr(RefusalReason),
  endUserPolicyUrl: Schema.URLFromString,
  endUserPolicyText: Schema.String,
  endUserPolicySha256: Schema.String,
  endUserPolicyProviderHash: Schema.String,
  personalAuthUrl: Schema.URLFromString,
  personalAuthText: Schema.String,
  personalAuthSha256: Schema.String,
  personalAuthProviderHash: Schema.String,
  contractsObservedAt: Schema.DateTimeUtcFromDate,
  disclosureRevision: RecurringDisclosure.fields.revision,
  disclosureText: RecurringDisclosure.fields.displayedText,
  disclosureSha256: RecurringDisclosure.fields.contentSha256,
  preparedAt: Schema.DateTimeUtcFromDate,
  expiresAt: Schema.DateTimeUtcFromDate,
  acceptedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  paymentSourceId: Schema.NullOr(CardPaymentSourceId),
});
export type EnrollmentRecord = typeof EnrollmentRow.Type;

const enrollmentColumns = `id, price_id AS "priceId", billing_email AS "billingEmail",
  payment_source_mode AS "paymentSourceMode", status, refusal_reason AS "refusalReason",
  end_user_policy_url AS "endUserPolicyUrl", end_user_policy_text AS "endUserPolicyText",
  end_user_policy_sha256 AS "endUserPolicySha256",
  end_user_policy_provider_hash AS "endUserPolicyProviderHash",
  personal_auth_url AS "personalAuthUrl", personal_auth_text AS "personalAuthText",
  personal_auth_sha256 AS "personalAuthSha256",
  personal_auth_provider_hash AS "personalAuthProviderHash", contracts_observed_at AS "contractsObservedAt", disclosure_revision AS "disclosureRevision",
  disclosure_text AS "disclosureText", disclosure_sha256 AS "disclosureSha256",
  prepared_at AS "preparedAt", expires_at AS "expiresAt", accepted_at AS "acceptedAt",
  payment_source_id AS "paymentSourceId"`;

/** Finds one User-owned enrollment by identity inside the caller's User transaction. */
export const findEnrollmentInScope = Effect.fn("Subscription.findEnrollmentInScope")(function* (
  userId: UserId,
  enrollmentId: CardEnrollmentId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: EnrollmentRow,
    execute: () => sql`
        SELECT ${sql.literal(enrollmentColumns)} FROM card_enrollments
        WHERE user_id = ${userId} AND id = ${enrollmentId}
      `,
  })(undefined).pipe(Effect.orDie);
});

/** Finds the one replay-blocking enrollment, if present, inside the caller's User transaction. */
export const findPendingEnrollmentInScope = Effect.fn("Subscription.findPendingEnrollmentInScope")(
  function* (userId: UserId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: EnrollmentRow,
      execute: () => sql`
      SELECT ${sql.literal(enrollmentColumns)} FROM card_enrollments
      WHERE user_id = ${userId} AND status IN ('prepared', 'creating', 'verifying')
      ORDER BY prepared_at DESC, id DESC LIMIT 1
    `,
    })(undefined).pipe(Effect.orDie);
  }
);

/** Finds the newest accepted Price authorization associated with the User's reusable card. */
export const findAvailableEnrollmentInScope = Effect.fn(
  "Subscription.findAvailableEnrollmentInScope"
)(function* (userId: UserId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: EnrollmentRow,
    execute: () => sql`
      SELECT ${sql.literal(enrollmentColumns)} FROM card_enrollments
      WHERE user_id = ${userId} AND status = 'available'
      ORDER BY accepted_at DESC, id DESC LIMIT 1
    `,
  })(undefined).pipe(Effect.orDie);
});

const SourceIdentity = Schema.Struct({ id: CardPaymentSourceId });

/** Finds the private reusable source identity without exposing the Wompi provider reference. */
export const findPaymentSourceInScope = Effect.fn("Subscription.findPaymentSourceInScope")(
  function* (userId: UserId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: SourceIdentity,
      execute: () => sql`
        SELECT id FROM card_payment_sources WHERE user_id = ${userId} AND status = 'available'
      `,
    })(undefined).pipe(Effect.orDie);
  }
);

/** Replaces only unaccepted disclosure state and inserts one new expiring enrollment intent. */
export const insertPreparedEnrollmentInScope = Effect.fn(
  "Subscription.insertPreparedEnrollmentInScope"
)(function* (input: {
  userId: UserId;
  enrollmentId: CardEnrollmentId;
  priceId: PriceId;
  billingEmail: BillingEmail;
  paymentSourceMode: "create" | "reuse";
  contracts: WompiContractEvidenceSet;
  disclosure: RecurringDisclosure;
  preparedAt: DateTime.Utc;
  expiresAt: DateTime.Utc;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE card_enrollments SET status = 'expired'
    WHERE user_id = ${input.userId} AND status = 'prepared'
  `.pipe(Effect.orDie);
  const endUser = input.contracts.endUserPolicy;
  const personalData = input.contracts.personalDataAuthorization;
  yield* sql`
    INSERT INTO card_enrollments (
      id, user_id, price_id, billing_email, payment_source_mode, status,
      end_user_policy_url, end_user_policy_text, end_user_policy_sha256,
      end_user_policy_provider_hash, personal_auth_url, personal_auth_text,
      personal_auth_sha256, personal_auth_provider_hash, contracts_observed_at,
      disclosure_revision, disclosure_text, disclosure_sha256, prepared_at, expires_at
    ) VALUES (
      ${input.enrollmentId}, ${input.userId}, ${input.priceId}, ${input.billingEmail},
      ${input.paymentSourceMode}, 'prepared', ${endUser.permalink.href}, ${endUser.displayedText},
      ${endUser.contentSha256}, ${endUser.providerContentHash}, ${personalData.permalink.href},
      ${personalData.displayedText}, ${personalData.contentSha256},
      ${personalData.providerContentHash}, ${endUser.observedAt}, ${input.disclosure.revision},
      ${input.disclosure.displayedText}, ${input.disclosure.contentSha256},
      ${input.preparedAt}, ${input.expiresAt}
    )
  `.pipe(Effect.orDie);
});

/** Checks the User-stable hourly preparation budget inside the enrollment lock. */
export const hasEnrollmentPreparationCapacityInScope = Effect.fn(
  "Subscription.hasEnrollmentPreparationCapacityInScope"
)(function* (userId: UserId, preparedAt: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: SourceCreationCapacity,
    execute: () => sql`
      SELECT COUNT(*) < ${maximumEnrollmentPreparationsPerHour} AS available
      FROM card_enrollments
      WHERE user_id = ${userId}
        AND prepared_at > ${preparedAt}::timestamptz - INTERVAL '1 hour'
    `,
  })(undefined).pipe(
    Effect.map((result) => result.available),
    Effect.orDie
  );
});

/** Checks the User-stable hourly source-creation budget inside the enrollment lock. */
export const hasSourceCreationCapacityInScope = Effect.fn(
  "Subscription.hasSourceCreationCapacityInScope"
)(function* (userId: UserId, acceptedAt: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: SourceCreationCapacity,
    execute: () => sql`
      SELECT COUNT(*) < ${maximumSourceCreationAttemptsPerHour} AS available
      FROM card_enrollments
      WHERE user_id = ${userId} AND payment_source_mode = 'create' AND accepted_at IS NOT NULL
        AND accepted_at > ${acceptedAt}::timestamptz - INTERVAL '1 hour'
    `,
  })(undefined).pipe(
    Effect.map((result) => result.available),
    Effect.orDie
  );
});

/** Records that one prepared enrollment exceeded its submission window. */
export const expireEnrollmentInScope = Effect.fn("Subscription.expireEnrollmentInScope")(function* (
  userId: UserId,
  enrollmentId: CardEnrollmentId,
  expiredAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      UPDATE card_enrollments SET status = 'expired'
      WHERE user_id = ${userId} AND id = ${enrollmentId}
        AND status = 'prepared' AND expires_at <= ${expiredAt}
    `.pipe(Effect.orDie);
});

/** Atomically begins one live submission; false means replay must return its current state. */
export const beginEnrollmentSubmissionInScope = Effect.fn(
  "Subscription.beginEnrollmentSubmissionInScope"
)(function* (input: {
  userId: UserId;
  enrollmentId: CardEnrollmentId;
  billingEmail: BillingEmail;
  acceptedAt: DateTime.Utc;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    UPDATE card_enrollments SET status = 'creating', billing_email = ${input.billingEmail},
      accepted_at = ${input.acceptedAt}
    WHERE user_id = ${input.userId} AND id = ${input.enrollmentId}
      AND status = 'prepared' AND expires_at > ${input.acceptedAt}
    RETURNING id
  `.pipe(Effect.orDie);
  return rows.length === 1;
});

/** Settles a claimed reauthorization against the already-retained private source. */
export const reusePaymentSourceInScope = Effect.fn("Subscription.reusePaymentSourceInScope")(
  function* (userId: UserId, enrollmentId: CardEnrollmentId, paymentSourceId: CardPaymentSourceId) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE card_enrollments SET status = 'available', payment_source_id = ${paymentSourceId}
      WHERE user_id = ${userId} AND id = ${enrollmentId} AND status = 'creating'
    `.pipe(Effect.orDie);
  }
);

/** Retains a newly available provider source privately and settles its claimed enrollment. */
export const retainAvailableSourceInScope = Effect.fn("Subscription.retainAvailableSourceInScope")(
  function* (input: {
    userId: UserId;
    enrollmentId: CardEnrollmentId;
    paymentSourceId: CardPaymentSourceId;
    wompiSourceId: WompiSourceId;
    createdAt: DateTime.Utc;
  }) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO card_payment_sources (id, user_id, wompi_source_id, status, created_at)
      VALUES (
        ${input.paymentSourceId}, ${input.userId}, ${input.wompiSourceId}, 'available',
        ${input.createdAt}
      )
    `.pipe(Effect.orDie);
    yield* reusePaymentSourceInScope(input.userId, input.enrollmentId, input.paymentSourceId);
  }
);

/** Records a definitive refusal without retaining a provider body or transient token. */
export const refuseEnrollmentInScope = Effect.fn("Subscription.refuseEnrollmentInScope")(function* (
  userId: UserId,
  enrollmentId: CardEnrollmentId,
  reason: "provider-declined" | "provider-error" | "terms-changed"
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      UPDATE card_enrollments SET status = 'refused', refusal_reason = ${reason}
      WHERE user_id = ${userId} AND id = ${enrollmentId} AND status = 'creating'
    `.pipe(Effect.orDie);
});

/** Settles a manually verified refusal after an ambiguous provider response. */
export const reconcileRefusedEnrollmentInScope = Effect.fn(
  "Subscription.reconcileRefusedEnrollmentInScope"
)(function* (userId: UserId, enrollmentId: CardEnrollmentId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    UPDATE card_enrollments SET status = 'refused', refusal_reason = 'provider-error'
    WHERE user_id = ${userId} AND id = ${enrollmentId} AND status = 'verifying'
    RETURNING id
  `.pipe(Effect.orDie);
  return rows.length === 1;
});

/** Retains the source identity supplied by manual reconciliation of an ambiguous response. */
export const reconcileAvailableEnrollmentInScope = Effect.fn(
  "Subscription.reconcileAvailableEnrollmentInScope"
)(function* (input: {
  userId: UserId;
  enrollmentId: CardEnrollmentId;
  paymentSourceId: CardPaymentSourceId;
  wompiSourceId: WompiSourceId;
  reconciledAt: DateTime.Utc;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    UPDATE card_enrollments SET status = 'creating'
    WHERE user_id = ${input.userId} AND id = ${input.enrollmentId} AND status = 'verifying'
    RETURNING id
  `.pipe(Effect.orDie);
  if (rows.length !== 1) return false;
  yield* retainAvailableSourceInScope({
    userId: input.userId,
    enrollmentId: input.enrollmentId,
    paymentSourceId: input.paymentSourceId,
    wompiSourceId: input.wompiSourceId,
    createdAt: input.reconciledAt,
  });
  return true;
});

/** Fences an uncertain provider outcome from automatic source-creation replay. */
export const verifyEnrollmentInScope = Effect.fn("Subscription.verifyEnrollmentInScope")(function* (
  userId: UserId,
  enrollmentId: CardEnrollmentId
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      UPDATE card_enrollments SET status = 'verifying'
      WHERE user_id = ${userId} AND id = ${enrollmentId} AND status = 'creating'
    `.pipe(Effect.orDie);
});

/** Reconstructs both immutable Wompi contract snapshots from one trusted relational row. */
export const contractEvidenceFromRecord = (record: EnrollmentRecord): WompiContractEvidenceSet => ({
  endUserPolicy: {
    kind: "end-user-policy",
    permalink: record.endUserPolicyUrl,
    displayedText: record.endUserPolicyText,
    contentSha256: record.endUserPolicySha256,
    providerContentHash: record.endUserPolicyProviderHash,
    observedAt: record.contractsObservedAt,
  },
  personalDataAuthorization: {
    kind: "personal-data-authorization",
    permalink: record.personalAuthUrl,
    displayedText: record.personalAuthText,
    contentSha256: record.personalAuthSha256,
    providerContentHash: record.personalAuthProviderHash,
    observedAt: record.contractsObservedAt,
  },
});

/** Reconstructs the immutable Fidy disclosure retained with one enrollment. */
export const disclosureFromRecord = (record: EnrollmentRecord): RecurringDisclosure =>
  RecurringDisclosure.make({
    revision: record.disclosureRevision,
    displayedText: record.disclosureText,
    contentSha256: record.disclosureSha256,
  });
