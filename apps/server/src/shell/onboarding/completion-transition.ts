import { timingSafeEqual } from "node:crypto";
import { Crypto, Data, DateTime, Effect, Option, Redacted, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  type EmailEnrollmentCombinedCode,
  EmailEnrollmentPublicCode,
  RedactedEmailEnrollmentCombinedCode,
} from "~/core/email-authentication/model";
import {
  decideProofAttempt,
  formatEmailCode,
  isEmailEnrollmentExpired,
  selectEmailCodeSymbols,
} from "~/core/email-authentication/rules";
import { ConsentRecordId } from "~/core/consent/reference";
import { UserId } from "~/core/identity/reference";
import { BackupRecoveryCode } from "~/core/recovery/model";
import { WhatsAppCaller } from "~/shell/channels/whatsapp/model";
import {
  appendVerifiedOnboardingConsentInScope,
  removePendingConsentExchange,
} from "~/shell/consent/repo";
import {
  type EmailEnrollmentRow,
  findAndLockEmailEnrollmentByPublicCode,
  installVerifiedEmailCredentialInScope,
  recordWrongProofAttemptInScope,
  removeEmailEnrollment,
} from "~/shell/email-authentication/repo";
import { createVerifiedOnboardingIdentityInScope } from "~/shell/identity/repo";
import { installBackupRecoveryCredentialInScope } from "~/shell/recovery/repo";

export class EmailVerificationInvalid extends Data.TaggedError("EmailVerificationInvalid")<{}> {}
export class EmailAlreadyEnrolled extends Data.TaggedError("EmailAlreadyEnrolled")<{}> {}

// Produces a code like XXXXX-XXXXX-XXXXX-XXXXX-XXXXX.
const backupRecoveryCodeCharacterCount = 25;
const backupRecoveryCodeCharactersPerGroup = 5;
const decodeCombinedCode = Schema.decodeUnknownOption(RedactedEmailEnrollmentCombinedCode);

const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  timingSafeEqual(left, right);

const deleteBoundedEvidence = Effect.fn("Onboarding.deleteBoundedEvidence")(function* (
  enrollment: EmailEnrollmentRow
) {
  yield* removeEmailEnrollment(enrollment.id);
  yield* removePendingConsentExchange(enrollment.consent.pendingConsentExchangeId);
});

const acquireVerificationAdmission = Effect.fn("Onboarding.acquireVerificationAdmission")(
  function* () {
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
  }
);

const makeProofCandidate = Effect.fn("Onboarding.makeProofCandidate")(function* (
  combinedCode: EmailEnrollmentCombinedCode
) {
  const crypto = yield* Crypto.Crypto;
  const groups = combinedCode.split("-");
  const proof = groups.slice(2).join("-");
  return {
    publicCode: EmailEnrollmentPublicCode.make(`${groups[0]}-${groups[1]}`),
    digest: yield* crypto.digest("SHA-256", new TextEncoder().encode(proof)).pipe(Effect.orDie),
  };
});

const makeStableMaterial = Effect.fn("Onboarding.makeStableMaterial")(function* () {
  const crypto = yield* Crypto.Crypto;
  const recoverySymbols = selectEmailCodeSymbols({
    bytes: yield* crypto.randomBytes(backupRecoveryCodeCharacterCount).pipe(Effect.orDie),
    maximum: backupRecoveryCodeCharacterCount,
  });
  const recoveryCode = BackupRecoveryCode.make(
    formatEmailCode({
      symbols: recoverySymbols,
      groupSize: backupRecoveryCodeCharactersPerGroup,
    })
  );
  return {
    recoveryCode,
    recoveryDigest: yield* crypto
      .digest("SHA-256", new TextEncoder().encode(recoveryCode))
      .pipe(Effect.orDie),
    userId: UserId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
    consentRecordId: ConsentRecordId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
  };
});

type ReadyEmailEnrollment = Extract<EmailEnrollmentRow, { readonly _tag: "AwaitingProof" }>;
type StableMaterial = Effect.Success<ReturnType<typeof makeStableMaterial>>;

const admitLockedProof = Effect.fn("Onboarding.admitLockedProof")(function* (
  enrollment: EmailEnrollmentRow,
  candidateDigest: Uint8Array,
  attemptedAt: DateTime.Utc
) {
  if (isEmailEnrollmentExpired({ attemptedAt, expiresAt: enrollment.expiresAt })) {
    yield* deleteBoundedEvidence(enrollment);
    return Option.none<ReadyEmailEnrollment>();
  }
  if (enrollment._tag !== "AwaitingProof") return Option.none<ReadyEmailEnrollment>();
  const decision = yield* decideProofAttempt({
    digestMatches: constantTimeEqual(candidateDigest, enrollment.proofDigest),
    wrongAttempts: enrollment.wrongProofAttempts,
    proofExpiresAt: enrollment.proofExpiresAt,
    enrollmentExpiresAt: enrollment.expiresAt,
    attemptedAt,
  });
  if (decision._tag === "Expired") return Option.none<ReadyEmailEnrollment>();
  if (decision._tag === "Delete") {
    yield* deleteBoundedEvidence(enrollment);
    return Option.none<ReadyEmailEnrollment>();
  }
  if (decision._tag === "Wrong") {
    yield* recordWrongProofAttemptInScope({
      enrollmentId: enrollment.id,
      wrongAttempts: decision.wrongAttempts,
    });
    return Option.none<ReadyEmailEnrollment>();
  }
  return Option.some(enrollment);
});

const createStableState = Effect.fn("Onboarding.createStableState")(function* (
  enrollment: ReadyEmailEnrollment,
  material: StableMaterial,
  verifiedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`SELECT set_config('fidy.user_id', ${material.userId}, true)`.pipe(Effect.orDie);
  yield* createVerifiedOnboardingIdentityInScope({
    userId: material.userId,
    caller: WhatsAppCaller.make(enrollment.caller),
    createdAt: verifiedAt,
  });
  yield* appendVerifiedOnboardingConsentInScope({
    recordId: material.consentRecordId,
    subjectUserId: material.userId,
    pendingExchangeId: enrollment.consent.pendingConsentExchangeId,
  });
  const installed = yield* installVerifiedEmailCredentialInScope({
    userId: material.userId,
    email: enrollment.email,
    verifiedAt,
  });
  if (!installed) return yield* new EmailAlreadyEnrolled();
  yield* installBackupRecoveryCredentialInScope({
    userId: material.userId,
    codeDigest: material.recoveryDigest,
    createdAt: verifiedAt,
  });
  yield* deleteBoundedEvidence(enrollment);
});

const runCompletionTransaction = Effect.fn("Onboarding.runCompletionTransaction")(function* (
  input: Readonly<{ combinedCode: Redacted.Redacted<unknown> }>
) {
  if (!(yield* acquireVerificationAdmission())) return Option.none<BackupRecoveryCode>();
  const decoded = decodeCombinedCode(Redacted.value(input.combinedCode));
  if (Option.isNone(decoded)) return Option.none<BackupRecoveryCode>();
  const candidate = yield* makeProofCandidate(Redacted.value(decoded.value));
  const found = yield* findAndLockEmailEnrollmentByPublicCode(candidate.publicCode);
  if (Option.isNone(found)) return Option.none<BackupRecoveryCode>();
  const verifiedAt = yield* DateTime.now;
  const admitted = yield* admitLockedProof(found.value, candidate.digest, verifiedAt);
  if (Option.isNone(admitted)) return Option.none<BackupRecoveryCode>();
  const material = yield* makeStableMaterial();
  yield* createStableState(admitted.value, material, verifiedAt);
  return Option.some(material.recoveryCode);
});

/** Starts PostgreSQL before decoding or performing any proof or stable-material work. */
export const completeVerifiedOnboardingTransition = Effect.fn("Onboarding.completeTransition")(
  function* (input: Readonly<{ combinedCode: Redacted.Redacted<unknown> }>) {
    const sql = yield* SqlClient.SqlClient;
    const completed = yield* sql
      .withTransaction(runCompletionTransaction(input))
      .pipe(Effect.catchTag("SqlError", Effect.die));
    if (Option.isNone(completed)) return yield* new EmailVerificationInvalid();
    return {
      status: "created" as const,
      backupRecoveryCode: Redacted.make(completed.value),
    };
  }
);
