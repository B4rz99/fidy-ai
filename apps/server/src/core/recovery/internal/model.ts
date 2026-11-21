import { DateTime, Match, Schema } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";
import { BrowserLoginPairingId } from "~/core/browser-login/contract";
import { UserId } from "~/core/identity/contract";

const sha256ByteLength = 32;

const sha256DigestLength = Schema.makeFilter<{ readonly length: number }>((digest) =>
  digest.length === sha256ByteLength ? undefined : "Expected a 32-byte SHA-256 digest"
);

export const BackupRecoveryDigest = Schema.Uint8Array.check(sha256DigestLength);

export type BackupRecoveryDigest = typeof BackupRecoveryDigest.Type;

export const SupportOperatorId = Schema.Struct({
  issuer: Schema.String.check(Schema.isNonEmpty()),
  subject: Schema.String.check(Schema.isNonEmpty()),
}).annotate({ identifier: "SupportOperatorId" });

export type SupportOperatorId = typeof SupportOperatorId.Type;

export const SupportRecoveryCaseId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("SupportRecoveryCaseId"))
  .annotate({ identifier: "SupportRecoveryCaseId" });

export type SupportRecoveryCaseId = typeof SupportRecoveryCaseId.Type;

export const SupportRecoveryCaseEventId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("SupportRecoveryCaseEventId"))
  .annotate({ identifier: "SupportRecoveryCaseEventId" });

export type SupportRecoveryCaseEventId = typeof SupportRecoveryCaseEventId.Type;

export const ActiveBackupRecoveryCredential = Schema.TaggedStruct("Active", {
  userId: UserId,
  codeDigest: BackupRecoveryDigest,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  createdAt: UtcTimestamp,
});

export const ConsumedBackupRecoveryCredential = Schema.TaggedStruct("Consumed", {
  userId: UserId,
  consumedAt: UtcTimestamp,
  consumedByCaseId: Schema.Option(SupportRecoveryCaseId),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  createdAt: UtcTimestamp,
});

const BackupRecoveryCredentialVariants = Schema.Union([
  ActiveBackupRecoveryCredential,
  ConsumedBackupRecoveryCredential,
]);

const consumedNoEarlierThanCreated = Match.type<
  typeof BackupRecoveryCredentialVariants.Type
>().pipe(
  Match.tag("Active", () => true),
  Match.tag(
    "Consumed",
    (credential) => DateTime.Order(credential.createdAt, credential.consumedAt) <= 0
  ),
  Match.exhaustive
);

const validCredentialTimes = Schema.makeFilter<typeof BackupRecoveryCredentialVariants.Type>(
  (credential) =>
    consumedNoEarlierThanCreated(credential)
      ? undefined
      : { path: ["consumedAt"], issue: "Expected an instant at or after createdAt" }
);

export const BackupRecoveryCredentialLifecycle = BackupRecoveryCredentialVariants.check(
  validCredentialTimes
).annotate({ identifier: "BackupRecoveryCredentialLifecycle" });

export type BackupRecoveryCredentialLifecycle = typeof BackupRecoveryCredentialLifecycle.Type;

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

export const OperatorActor = Schema.TaggedStruct("Operator", { operatorId: SupportOperatorId });

const ExpiryActor = Schema.TaggedStruct("Policy", {
  policyRevision: Schema.Literal("support-recovery-expiry-v1"),
});

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
