import { Crypto, DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  EmailAddress,
  EmailDeliveryClaimToken,
  EmailDeliveryIntentId,
  EmailEnrollmentId,
  EmailVerificationCode,
  EmailVerificationProof,
  EmailVerificationPublicCode,
  PendingEmailEnrollment,
  type PendingEmailEnrollment as PendingEmailEnrollmentType,
} from "~/core/email-authentication/model";
import { PendingConsentExchangeId } from "~/core/consent/reference";
import {
  formatEmailCode,
  proofExpiry,
  selectEmailCodeSymbols,
} from "~/core/email-authentication/rules";
import type { WhatsAppCaller } from "~/shell/channels/whatsapp/model";
import {
  E164PhoneNumber,
  type UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
  WhatsAppParentBusinessScopedUserId,
  WhatsAppUsername,
} from "~/core/identity/reference";
import { emailCredentialLookupKey } from "./admission";

/** Acquires one transaction-scoped verification-capacity slot without waiting. */
export const acquireEmailVerificationAdmissionInScope = Effect.fn(
  "EmailAuthentication.acquireVerificationAdmissionInScope"
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const slot = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ slot: Schema.Int }),
    execute: () => sql`
      SELECT slot FROM email_verification_admission_slots
      ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1
    `,
  })(undefined).pipe(Effect.orDie);
  return Option.isSome(slot);
});

const EnrollmentStorageRow = Schema.Struct({
  id: EmailEnrollmentId,
  publicCode: EmailVerificationPublicCode,
  businessPortfolioId: WhatsAppBusinessPortfolioId,
  businessScopedUserId: WhatsAppBusinessScopedUserId,
  parentBusinessScopedUserId: Schema.OptionFromNullOr(WhatsAppParentBusinessScopedUserId),
  username: Schema.OptionFromNullOr(WhatsAppUsername),
  phoneNumber: Schema.OptionFromNullOr(E164PhoneNumber),
  pendingConsentExchangeId: PendingConsentExchangeId,
  expiresAt: Schema.DateTimeUtcFromDate,
  emailAddress: Schema.OptionFromNullOr(EmailAddress),
  deliveryGeneration: Schema.Int,
  resendAvailableAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  proofDigest: Schema.OptionFromNullOr(Schema.Uint8Array),
  proofExpiresAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  wrongProofAttempts: Schema.Int,
});
type EnrollmentStorageRow = typeof EnrollmentStorageRow.Type;
type WithWhatsAppCaller<Enrollment> = Enrollment extends unknown
  ? Omit<Enrollment, "caller"> & { readonly caller: WhatsAppCaller }
  : never;
export type EmailEnrollmentRow = WithWhatsAppCaller<PendingEmailEnrollmentType>;

const decodePendingEmailEnrollment = Schema.decodeUnknownEffect(
  Schema.toType(PendingEmailEnrollment)
);

const enrollmentFromStorage = Effect.fn(function* (row: EnrollmentStorageRow) {
  const caller: WhatsAppCaller = {
    businessPortfolioId: row.businessPortfolioId,
    businessScopedUserId: row.businessScopedUserId,
    parentBusinessScopedUserId: row.parentBusinessScopedUserId,
    username: row.username,
    phoneNumber: row.phoneNumber,
  };
  const base = {
    id: row.id,
    publicCode: row.publicCode,
    caller: {
      businessPortfolioId: caller.businessPortfolioId,
      businessScopedUserId: caller.businessScopedUserId,
    },
    consent: { pendingConsentExchangeId: row.pendingConsentExchangeId },
    expiresAt: row.expiresAt,
  };
  if (Option.isNone(row.emailAddress)) {
    const decoded = yield* decodePendingEmailEnrollment({ _tag: "AwaitingEmail", ...base });
    return { ...decoded, caller };
  }
  const delivery = {
    ...base,
    email: row.emailAddress.value,
    deliveryGeneration: row.deliveryGeneration,
    resendAvailableAt: Option.getOrThrow(row.resendAvailableAt),
    wrongProofAttempts: row.wrongProofAttempts,
  };
  if (Option.isNone(row.proofDigest) && Option.isNone(row.proofExpiresAt)) {
    const decoded = yield* decodePendingEmailEnrollment({
      _tag: "AwaitingProofDelivery",
      ...delivery,
    });
    return { ...decoded, caller };
  }
  const decoded = yield* decodePendingEmailEnrollment({
    _tag: "AwaitingProof",
    ...delivery,
    proofDigest: Option.getOrThrow(row.proofDigest),
    proofExpiresAt: Option.getOrThrow(row.proofExpiresAt),
  });
  return { ...decoded, caller };
}, Effect.orDie);

const columns = `id, public_code AS "publicCode", business_portfolio_id AS "businessPortfolioId",
  business_scoped_user_id AS "businessScopedUserId",
  parent_business_scoped_user_id AS "parentBusinessScopedUserId", username,
  phone_number AS "phoneNumber", pending_consent_exchange_id AS "pendingConsentExchangeId",
  expires_at AS "expiresAt", email_address AS "emailAddress",
  delivery_generation AS "deliveryGeneration", resend_available_at AS "resendAvailableAt",
  proof_digest AS "proofDigest", proof_expires_at AS "proofExpiresAt",
  wrong_proof_attempts AS "wrongProofAttempts"`;

/** Inserts the pre-User enrollment in the caller-lock transaction; caller replay returns its row. */
export const insertEmailEnrollment = Effect.fn("EmailAuthentication.insertEnrollment")(function* (
  input: Readonly<{
    id: EmailEnrollmentId;
    publicCode: EmailVerificationPublicCode;
    caller: WhatsAppCaller;
    pendingConsentExchangeId: PendingConsentExchangeId;
    expiresAt: DateTime.Utc;
  }>
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: EnrollmentStorageRow,
    execute: () => sql`
      INSERT INTO email_enrollments (
        id, public_code, business_portfolio_id, business_scoped_user_id,
        parent_business_scoped_user_id, username, phone_number,
        pending_consent_exchange_id, expires_at
      ) VALUES (
        ${input.id}, ${input.publicCode}, ${input.caller.businessPortfolioId},
        ${input.caller.businessScopedUserId}, ${Option.getOrNull(input.caller.parentBusinessScopedUserId)},
        ${Option.getOrNull(input.caller.username)}, ${Option.getOrNull(input.caller.phoneNumber)},
        ${input.pendingConsentExchangeId}, ${input.expiresAt}
      )
      ON CONFLICT (business_portfolio_id, business_scoped_user_id) DO UPDATE
        SET business_scoped_user_id = EXCLUDED.business_scoped_user_id
      RETURNING ${sql.literal(columns)}
    `,
  })(undefined).pipe(Effect.orDie);
  return yield* enrollmentFromStorage(row);
});

/** Observes the caller's enrollment without acquiring a transaction lock; absence returns none. */
export const findEmailEnrollmentByCaller = Effect.fn("EmailAuthentication.findEnrollmentByCaller")(
  function* (caller: WhatsAppCaller) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: EnrollmentStorageRow,
      execute: () => sql`
        SELECT ${sql.literal(columns)} FROM email_enrollments
        WHERE business_portfolio_id = ${caller.businessPortfolioId}
          AND business_scoped_user_id = ${caller.businessScopedUserId}
      `,
    })(undefined).pipe(Effect.orDie);
    const row = Option.fromNullishOr(rows[0]);
    if (Option.isNone(row)) return Option.none<EmailEnrollmentRow>();
    return Option.some(yield* enrollmentFromStorage(row.value));
  }
);

/** Locks the caller's enrollment inside an already-open transaction; absence returns none. */
export const findAndLockEmailEnrollmentByCaller = Effect.fn(
  "EmailAuthentication.findAndLockEnrollmentByCaller"
)(function* (caller: WhatsAppCaller) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: EnrollmentStorageRow,
    execute: () => sql`
      SELECT ${sql.literal(columns)} FROM email_enrollments
      WHERE business_portfolio_id = ${caller.businessPortfolioId}
        AND business_scoped_user_id = ${caller.businessScopedUserId}
      FOR UPDATE
    `,
  })(undefined).pipe(Effect.orDie);
  const row = Option.fromNullishOr(rows[0]);
  if (Option.isNone(row)) return Option.none<EmailEnrollmentRow>();
  return Option.some(yield* enrollmentFromStorage(row.value));
});

/** Locks current proof state by public code in the completion transaction; absence returns none. */
export const findAndLockEmailEnrollmentByPublicCode = Effect.fn(
  "EmailAuthentication.findAndLockEnrollmentByPublicCode"
)(function* (publicCode: EmailVerificationPublicCode) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: EnrollmentStorageRow,
    execute: () => sql`
      SELECT ${sql.literal(columns)} FROM email_enrollments
      WHERE public_code = ${publicCode} FOR UPDATE
    `,
  })(undefined).pipe(Effect.orDie);
  if (Option.isNone(row)) return Option.none<EmailEnrollmentRow>();
  return Option.some(yield* enrollmentFromStorage(row.value));
});

/** Persists a bounded wrong-proof count inside the completion transaction. */
export const recordWrongProofAttemptInScope = Effect.fn(
  "EmailAuthentication.recordWrongProofAttemptInScope"
)(function* (input: Readonly<{ enrollmentId: EmailEnrollmentId; wrongAttempts: number }>) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE email_enrollments SET wrong_proof_attempts = ${input.wrongAttempts}
    WHERE id = ${input.enrollmentId}
  `.pipe(Effect.orDie);
});

/** Deletes enrollment-owned bounded evidence; dependent intents cascade and absence is idempotent. */
export const removeEmailEnrollment = Effect.fn("EmailAuthentication.removeEnrollment")(function* (
  enrollmentId: EmailEnrollmentId
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM email_enrollments WHERE id = ${enrollmentId}`.pipe(Effect.orDie);
});

type SubmitEnrollmentEmailInput = Readonly<{
  enrollmentId: EmailEnrollmentId;
  email: EmailAddress;
  intentId: EmailDeliveryIntentId;
  idempotencyKey: string;
  submittedAt: DateTime.Utc;
  resendAvailableAt: DateTime.Utc;
}>;

/** Supersedes every earlier generation and persists only a fresh durable delivery intent. */
export const submitEnrollmentEmail = Effect.fn("EmailAuthentication.submitEmail")(function* (
  input: SubmitEnrollmentEmailInput
) {
  const sql = yield* SqlClient.SqlClient;
  const admitted = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ generation: Schema.Int }),
    execute: () => sql`
        WITH advanced AS (
          UPDATE email_enrollments SET email_address = ${input.email},
            delivery_generation = delivery_generation + 1,
            resend_available_at = ${input.resendAvailableAt}, proof_digest = NULL,
            proof_expires_at = NULL, wrong_proof_attempts = 0
          WHERE id = ${input.enrollmentId} AND delivery_generation < 5
          RETURNING delivery_generation AS generation
        ), superseded AS (
          UPDATE email_delivery_intents SET status = 'superseded',
            claim_token = NULL, claim_expires_at = NULL
          WHERE enrollment_id = ${input.enrollmentId} AND status <> 'superseded'
            AND EXISTS (SELECT 1 FROM advanced)
        )
        INSERT INTO email_delivery_intents (
          id, enrollment_id, generation, email_address, status, idempotency_key, created_at
        ) SELECT ${input.intentId}, ${input.enrollmentId}, generation, ${input.email}, 'pending',
          ${input.idempotencyKey}, ${input.submittedAt} FROM advanced
        RETURNING generation
      `,
  })(undefined).pipe(Effect.orDie);
  return Option.map(admitted, ({ generation }) => generation);
});

const ClaimedIntent = Schema.Struct({
  id: Schema.toEncoded(EmailDeliveryIntentId),
  enrollmentId: Schema.toEncoded(EmailEnrollmentId),
  generation: Schema.Int,
  email: EmailAddress,
  publicCode: Schema.toEncoded(EmailVerificationPublicCode),
  idempotencyKey: Schema.String,
  claimToken: Schema.toEncoded(EmailDeliveryClaimToken),
  enrollmentExpiresAt: Schema.DateTimeUtcFromDate,
});
type ClaimedEmailDeliveryIntentRow = typeof ClaimedIntent.Type;
export type ClaimedEmailDeliveryIntent = ClaimedEmailDeliveryIntentRow &
  Readonly<{ combinedCode: EmailVerificationCode }>;

const proofSymbolCount = 16;
const verificationGroupSize = 4;

export const makeEmailDeliveryProof = Effect.fn("EmailAuthentication.makeDeliveryProof")(
  function* () {
    const crypto = yield* Crypto.Crypto;
    const proof = EmailVerificationProof.make(
      formatEmailCode({
        symbols: selectEmailCodeSymbols({
          bytes: yield* crypto.randomBytes(proofSymbolCount).pipe(Effect.orDie),
          maximum: proofSymbolCount,
        }),
        groupSize: verificationGroupSize,
      })
    );
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(proof))
      .pipe(Effect.orDie);
    return { digest, proof };
  }
);

/** Atomically claims one current intent and installs only its fresh proof digest. */
export const claimAndArmEmailDeliveryIntent = Effect.fn("EmailAuthentication.claimAndArmDelivery")(
  function* (
    input: Readonly<{
      claimToken: EmailDeliveryClaimToken;
      claimedAt: DateTime.Utc;
      claimExpiresAt: DateTime.Utc;
    }>
  ) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: ClaimedIntent,
          execute: () => sql`
          WITH candidate AS (
            SELECT intent.id FROM email_delivery_intents AS intent
            JOIN email_enrollments AS enrollment ON enrollment.id = intent.enrollment_id
            WHERE (intent.status = 'pending'
              OR (intent.status = 'claimed' AND intent.claim_expires_at <= ${input.claimedAt}
                AND enrollment.proof_digest IS NULL))
              AND intent.generation = enrollment.delivery_generation
              AND enrollment.expires_at > ${input.claimedAt}
            ORDER BY intent.created_at, intent.id
            FOR UPDATE OF intent SKIP LOCKED LIMIT 1
          )
          UPDATE email_delivery_intents AS intent
          SET status = 'claimed', claim_token = ${input.claimToken},
            claim_expires_at = ${input.claimExpiresAt}
          FROM candidate, email_enrollments AS enrollment
          WHERE intent.id = candidate.id AND enrollment.id = intent.enrollment_id
          RETURNING intent.id, intent.enrollment_id AS "enrollmentId", intent.generation,
            intent.email_address AS email, enrollment.public_code AS "publicCode",
            intent.idempotency_key AS "idempotencyKey", intent.claim_token AS "claimToken",
            enrollment.expires_at AS "enrollmentExpiresAt"
        `,
        })(undefined).pipe(Effect.orDie);
        const claimed = Option.fromNullishOr(rows[0]);
        if (Option.isNone(claimed)) return Option.none<ClaimedEmailDeliveryIntent>();
        const { digest, proof } = yield* makeEmailDeliveryProof();
        const intent = claimed.value;
        const armed = yield* sql`
        UPDATE email_enrollments AS enrollment
        SET proof_digest = ${digest},
          proof_expires_at = ${DateTime.min(proofExpiry(input.claimedAt), intent.enrollmentExpiresAt)},
          wrong_proof_attempts = 0
        FROM email_delivery_intents AS delivery
        WHERE delivery.id = ${intent.id} AND delivery.enrollment_id = enrollment.id
          AND delivery.claim_token = ${intent.claimToken} AND delivery.status = 'claimed'
          AND delivery.generation = enrollment.delivery_generation
        RETURNING enrollment.id
      `.pipe(Effect.orDie);
        if (armed.length !== 1) return yield* Effect.die("claimed delivery could not be armed");
        return Option.some({
          ...intent,
          combinedCode: EmailVerificationCode.make(`${intent.publicCode}-${proof}`),
        });
      })
    );
  }
);

/** Marks armed claims whose process vanished as uncertain without generating another proof. */
export const reconcileExpiredArmedClaims = Effect.fn(
  "EmailAuthentication.reconcileExpiredArmedClaims"
)(function* (reconciledAt: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE email_delivery_intents AS intent SET status = 'uncertain',
      claim_token = NULL, claim_expires_at = NULL
    FROM email_enrollments AS enrollment
    WHERE intent.enrollment_id = enrollment.id AND intent.status = 'claimed'
      AND intent.claim_expires_at <= ${reconciledAt} AND enrollment.proof_digest IS NOT NULL
  `.pipe(Effect.orDie);
});

/** Installs the unique stable credential inside the coordinator's already-open transaction. */
export const installVerifiedEmailCredentialInScope = Effect.fn(
  "EmailAuthentication.installVerifiedCredentialInScope"
)(function* (
  input: Readonly<{
    userId: UserId;
    email: EmailAddress;
    verifiedAt: DateTime.Utc;
  }>
) {
  const sql = yield* SqlClient.SqlClient;
  const lookupKey = yield* emailCredentialLookupKey(input.email).pipe(Effect.orDie);
  const inserted = yield* sql`
    WITH credential AS (
      INSERT INTO verified_email_credentials (user_id, email_address, verified_at)
      VALUES (${input.userId}, ${input.email}, ${input.verifiedAt})
      ON CONFLICT DO NOTHING RETURNING user_id
    )
    INSERT INTO verified_email_credential_authentication_lookups (
      user_id, authentication_lookup_key
    ) SELECT user_id, ${lookupKey} FROM credential
    RETURNING user_id
  `.pipe(Effect.orDie);
  return inserted.length > 0;
});

const ExpiredEnrollment = Schema.Struct({ pendingConsentExchangeId: PendingConsentExchangeId });
const retentionBatchSize = 100;

/** Deletes one fixed-size indexed batch and returns the Consent exchanges it released. */
export const removeExpiredEmailEnrollments = Effect.fn(
  "EmailAuthentication.removeExpiredEnrollments"
)(function* (now: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: ExpiredEnrollment,
    execute: () => sql`
      WITH expired AS (
        SELECT id
        FROM email_enrollments
        WHERE expires_at <= ${now}
        ORDER BY expires_at, id
        LIMIT ${retentionBatchSize}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM email_enrollments AS enrollment
      USING expired
      WHERE enrollment.id = expired.id
      RETURNING enrollment.pending_consent_exchange_id AS "pendingConsentExchangeId"
    `,
  })(undefined).pipe(Effect.orDie);
});

/** Deletes one indexed fixed-size batch of expired caller and recipient delivery budgets. */
export const removeExpiredEmailDeliveryBudgets = Effect.fn(
  "EmailAuthentication.removeExpiredDeliveryBudgets"
)(function* (now: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    WITH expired AS (
      SELECT scope_key
      FROM email_delivery_admission_budgets
      WHERE expires_at <= ${now}
      ORDER BY expires_at, scope_key
      LIMIT ${retentionBatchSize}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM email_delivery_admission_budgets AS budget
    USING expired
    WHERE budget.scope_key = expired.scope_key
  `.pipe(Effect.orDie);
});

/**
 * Applies terminal delivery state only when intent, enrollment, claim token, and generation still
 * match. Returns `"stale"` for stale settlement and never mutates a superseded generation.
 */
export const settleEmailDelivery = Effect.fn("EmailAuthentication.settleDelivery")(
  function* (input: {
    readonly intent: ClaimedEmailDeliveryIntent;
    readonly status: "sent" | "rejected" | "uncertain";
    readonly providerMessageId: Option.Option<string>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const updated = yield* sql`
      UPDATE email_delivery_intents AS intent SET status = ${input.status},
        provider_message_id = ${Option.getOrNull(input.providerMessageId)},
        claim_token = NULL, claim_expires_at = NULL
      FROM email_enrollments AS enrollment
      WHERE intent.id = ${input.intent.id} AND intent.enrollment_id = ${input.intent.enrollmentId}
        AND enrollment.id = intent.enrollment_id
        AND intent.claim_token = ${input.intent.claimToken} AND intent.status = 'claimed'
        AND intent.generation = ${input.intent.generation}
        AND enrollment.delivery_generation = ${input.intent.generation}
      RETURNING intent.id
    `.pipe(Effect.orDie);
    return updated.length === 1 ? ("applied" as const) : ("stale" as const);
  }
);
