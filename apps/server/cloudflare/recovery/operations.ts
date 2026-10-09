import type { Effect } from "effect";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import type { BackupRecoveryCode } from "../../src/core/recovery/contract";
import type {
  InitialRecoveryEnrollment,
  RecoveryRequest,
  SupportRecoveryRequest,
} from "./contract";
import { recoveryCodeDigest, sampleRecoveryCode } from "./internal/material";
import { rotateBackupRecoveryCode as rotate } from "./internal/rotation";
import { handleSupportRecovery as handleSupport } from "./internal/support-recovery";

/**
 * Generate emergency proof for this verified new User, disclosing it only after the caller's
 * complete enrollment unit commits. Only its digest enters storage; send the returned code once
 * in the immediate no-store enrollment response, never to logs, durable work or another owner.
 */
export const issueInitialBackupRecoveryCode = ({
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

/** Replace the exact User's emergency proof under current fresh-session authority, disclosed once. */
export const rotateBackupRecoveryCode = (input: RecoveryRequest): Promise<Response> =>
  rotate(input);

/**
 * Verify the operator and consume an unused code in the exact pending pairing's atomic tracked
 * decision. The code's existing User cannot be substituted; approval never creates a User,
 * changes WhatsAppIdentity or creates a session without the browser's independent verifier.
 */
export const handleSupportRecovery = (input: SupportRecoveryRequest): Effect.Effect<Response> =>
  handleSupport(input);

/** Retained case evidence keeps its referenced pairing even when the browser never redeems it. */
export const retainedRecoveryPairingsQuery = (): OwnedStatement => ({
  sql: "SELECT pairing_id AS pairingId FROM support_recovery_cases",
  params: [],
});
