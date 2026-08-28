import { DateTime, Schema } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";
import { BrowserLoginPairingId } from "~/core/browser-login/reference";
import { UserId } from "~/core/identity/reference";

/**
 * Raw emergency proof disclosed once after onboarding. Its 25 unambiguous base32 symbols provide
 * approximately 125 random bits; only a SHA-256 digest crosses the persistence boundary.
 */
export const BackupRecoveryCode = Schema.String.check(
  Schema.isPattern(
    /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}){4}$/u
  )
)
  .pipe(Schema.brand("BackupRecoveryCode"))
  .annotate({ identifier: "BackupRecoveryCode" });
export type BackupRecoveryCode = typeof BackupRecoveryCode.Type;

const sha256ByteLength = 32;
const sha256DigestLength = Schema.makeFilter<{ readonly length: number }>((digest) =>
  digest.length === sha256ByteLength ? undefined : "Expected a 32-byte SHA-256 digest"
);

/** Checked digest accepted by Recovery persistence; raw BackupRecoveryCodes never cross this seam. */
export const BackupRecoveryDigest = Schema.Uint8Array.check(sha256DigestLength);
export type BackupRecoveryDigest = typeof BackupRecoveryDigest.Type;

/** Stable identity asserted by the dedicated Cloudflare Access application and verified at origin. */
export const SupportOperatorId = Schema.Struct({
  issuer: Schema.String.check(Schema.isNonEmpty()),
  subject: Schema.String.check(Schema.isNonEmpty()),
}).annotate({ identifier: "SupportOperatorId" });
export type SupportOperatorId = typeof SupportOperatorId.Type;

/** Stable SupportRecoveryCase identity. */
export const SupportRecoveryCaseId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("SupportRecoveryCaseId"))
  .annotate({ identifier: "SupportRecoveryCaseId" });
export type SupportRecoveryCaseId = typeof SupportRecoveryCaseId.Type;

/** Stable append-only SupportRecoveryCase event identity. */
export const SupportRecoveryCaseEventId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("SupportRecoveryCaseEventId"))
  .annotate({ identifier: "SupportRecoveryCaseEventId" });
export type SupportRecoveryCaseEventId = typeof SupportRecoveryCaseEventId.Type;

const BackupRecoveryCredentialVariants = Schema.Union([
  Schema.TaggedStruct("Active", {
    userId: UserId,
    codeDigest: BackupRecoveryDigest,
    revision: Schema.Int.check(Schema.isGreaterThan(0)),
    createdAt: UtcTimestamp,
  }),
  Schema.TaggedStruct("Consumed", {
    userId: UserId,
    consumedAt: UtcTimestamp,
    consumedByCaseId: Schema.Option(SupportRecoveryCaseId),
    revision: Schema.Int.check(Schema.isGreaterThan(0)),
    createdAt: UtcTimestamp,
  }),
]);
type BackupRecoveryCredentialTimeView =
  | Readonly<{ _tag: "Active" }>
  | Readonly<{ _tag: "Consumed"; createdAt: DateTime.Utc; consumedAt: DateTime.Utc }>;
const validCredentialTimes = Schema.makeFilter<BackupRecoveryCredentialTimeView>((credential) =>
  credential._tag === "Active" || DateTime.Order(credential.createdAt, credential.consumedAt) <= 0
    ? undefined
    : { path: ["consumedAt"], issue: "Expected an instant at or after createdAt" }
);

/** Credential authority is active exactly while its checked digest exists. */
export const BackupRecoveryCredentialLifecycle = BackupRecoveryCredentialVariants.check(
  validCredentialTimes
).annotate({ identifier: "BackupRecoveryCredentialLifecycle" });
export type BackupRecoveryCredentialLifecycle = typeof BackupRecoveryCredentialLifecycle.Type;

/** Recovery-owned one-time credential for one stable User. */
export const BackupRecoveryCredential = BackupRecoveryCredentialLifecycle.annotate({
  identifier: "BackupRecoveryCredential",
});
export type BackupRecoveryCredential = typeof BackupRecoveryCredential.Type;

const SupportRecoveryCaseIdentity = {
  id: SupportRecoveryCaseId,
  userId: UserId,
  pairingId: BrowserLoginPairingId,
  credentialRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  openedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
};

const SupportRecoveryCaseVariants = Schema.Union([
  Schema.Struct({
    ...SupportRecoveryCaseIdentity,
    lifecycle: Schema.Literal("open"),
  }),
  Schema.Struct({
    ...SupportRecoveryCaseIdentity,
    lifecycle: Schema.Literals(["approved", "refused", "expired"]),
    closedAt: UtcTimestamp,
  }),
]);
const validCaseTimes = Schema.makeFilter<typeof SupportRecoveryCaseVariants.Type>(
  (recoveryCase) => {
    if (DateTime.Order(recoveryCase.openedAt, recoveryCase.expiresAt) >= 0) {
      return { path: ["expiresAt"], issue: "Expected an instant after openedAt" };
    }
    if (recoveryCase.lifecycle === "open") return undefined;
    return DateTime.Order(recoveryCase.openedAt, recoveryCase.closedAt) <= 0 &&
      DateTime.Order(recoveryCase.closedAt, recoveryCase.expiresAt) <= 0
      ? undefined
      : { path: ["closedAt"], issue: "Expected an instant from openedAt through expiresAt" };
  }
);

/** Metadata-only tracked decision bounded by the selected BrowserLoginPairing expiry. */
export const SupportRecoveryCase = SupportRecoveryCaseVariants.check(validCaseTimes).annotate({
  identifier: "SupportRecoveryCase",
});
export type SupportRecoveryCase = typeof SupportRecoveryCase.Type;

const EventIdentity = {
  id: SupportRecoveryCaseEventId,
  caseId: SupportRecoveryCaseId,
  ordinal: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 })),
  occurredAt: UtcTimestamp,
};
const OperatorActor = Schema.TaggedStruct("Operator", { operatorId: SupportOperatorId });
const ExpiryActor = Schema.TaggedStruct("Policy", {
  policyRevision: Schema.Literal("support-recovery-expiry-v1"),
});

/**
 * Closed relational evidence vocabulary. Rejections deliberately retain no reason or matching fact;
 * automatic expiry names its fixed policy revision instead of inventing an operator.
 */
export const SupportRecoveryCaseEvent = Schema.Union([
  Schema.Struct({
    ...EventIdentity,
    actor: OperatorActor,
    action: Schema.Literal("open"),
    outcome: Schema.Literal("accepted"),
  }),
  Schema.Struct({
    ...EventIdentity,
    actor: OperatorActor,
    action: Schema.Literal("decide"),
    outcome: Schema.Literal("rejected"),
  }),
  Schema.Struct({
    ...EventIdentity,
    actor: OperatorActor,
    action: Schema.Literal("approve"),
    outcome: Schema.Literal("accepted"),
  }),
  Schema.Struct({
    ...EventIdentity,
    actor: OperatorActor,
    action: Schema.Literal("close"),
    outcome: Schema.Literal("refused"),
  }),
  Schema.Struct({
    ...EventIdentity,
    actor: ExpiryActor,
    action: Schema.Literal("expire"),
    outcome: Schema.Literal("expired"),
  }),
]).annotate({ identifier: "SupportRecoveryCaseEvent" });
export type SupportRecoveryCaseEvent = typeof SupportRecoveryCaseEvent.Type;

/** One-time canonical response disclosed only to the fresh first-party browser caller. */
export const RotatedBackupRecoveryCode = Schema.Struct({
  status: Schema.Literal("rotated"),
  backupRecoveryCode: Schema.RedactedFromValue(BackupRecoveryCode),
  rotatedAt: UtcTimestamp,
}).annotate({ identifier: "RotatedBackupRecoveryCode" });
export type RotatedBackupRecoveryCode = typeof RotatedBackupRecoveryCode.Type;
