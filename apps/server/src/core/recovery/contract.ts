import { Schema } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";

/** Emergency proof disclosed once. Its 25 unambiguous base32 symbols provide about 125 bits;
 * after disclosure only a digest remains, and an approved support decision consumes it. */
export const BackupRecoveryCode = Schema.String.check(
  Schema.isPattern(
    /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}){4}$/u
  )
)
  .pipe(Schema.brand("BackupRecoveryCode"))
  .annotate({ identifier: "BackupRecoveryCode" });
export type BackupRecoveryCode = typeof BackupRecoveryCode.Type;

/** One-time canonical disclosure to the fresh first-party browser caller. */
export const RotatedBackupRecoveryCode = Schema.Struct({
  status: Schema.Literal("rotated"),
  backupRecoveryCode: Schema.RedactedFromValue(BackupRecoveryCode),
  rotatedAt: UtcTimestamp,
}).annotate({ identifier: "RotatedBackupRecoveryCode" });
export type RotatedBackupRecoveryCode = typeof RotatedBackupRecoveryCode.Type;
