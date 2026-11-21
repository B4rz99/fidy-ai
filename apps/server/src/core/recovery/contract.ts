import { Schema } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";

export const BackupRecoveryCode = Schema.String.check(
  Schema.isPattern(
    /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}){4}$/u
  )
)
  .pipe(Schema.brand("BackupRecoveryCode"))
  .annotate({ identifier: "BackupRecoveryCode" });

export type BackupRecoveryCode = typeof BackupRecoveryCode.Type;

export const RotatedBackupRecoveryCode = Schema.Struct({
  status: Schema.Literal("rotated"),
  backupRecoveryCode: Schema.RedactedFromValue(BackupRecoveryCode),
  rotatedAt: UtcTimestamp,
}).annotate({ identifier: "RotatedBackupRecoveryCode" });

export type RotatedBackupRecoveryCode = typeof RotatedBackupRecoveryCode.Type;
