import { Schema } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";

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

/** One-time canonical response disclosed only to the fresh first-party browser caller. */
export const RotatedBackupRecoveryCode = Schema.Struct({
  status: Schema.Literal("rotated"),
  backupRecoveryCode: Schema.RedactedFromValue(BackupRecoveryCode),
  rotatedAt: UtcTimestamp,
}).annotate({ identifier: "RotatedBackupRecoveryCode" });
export type RotatedBackupRecoveryCode = typeof RotatedBackupRecoveryCode.Type;
