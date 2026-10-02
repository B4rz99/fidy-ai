import type { BackupRecoveryCode } from "../../../src/core/recovery/contract";
import type { InitialRecoveryEnrollment } from "../contract";
import { recoveryCodeDigest, sampleRecoveryCode } from "./material";

export const issueInitialCode = ({
  db,
  userId,
  createdAtMs,
  commit,
}: InitialRecoveryEnrollment): Promise<BackupRecoveryCode> => {
  const code = sampleRecoveryCode();
  return recoveryCodeDigest(code)
    .then((digest) =>
      commit(
        db
          .prepare(`INSERT INTO backup_recovery_credentials (user_id, code_digest, created_at_ms)
      VALUES (?, ?, ?)`)
          .bind(userId, digest, createdAtMs)
      )
    )
    .then(() => code);
};
