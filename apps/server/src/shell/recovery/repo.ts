import { type DateTime, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";

/** Recovery-owned digest installation inside onboarding's already-open transaction. */
export const installBackupRecoveryCredentialInScope = Effect.fn(
  "Recovery.installBackupRecoveryCredentialInScope"
)(function* (
  input: Readonly<{
    userId: UserId;
    codeDigest: Uint8Array;
    createdAt: DateTime.Utc;
  }>
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO backup_recovery_credentials (user_id, code_digest, created_at)
    VALUES (${input.userId}, ${input.codeDigest}, ${input.createdAt})
  `;
}, Effect.orDie);

/** Idempotent digest fixture write; production onboarding never calls this operation. */
export const upsertDevelopmentBackupRecoveryCredentialInScope = Effect.fn(
  "Recovery.upsertDevelopmentBackupRecoveryCredentialInScope"
)(function* (
  input: Readonly<{
    userId: UserId;
    codeDigest: Uint8Array;
    createdAt: DateTime.Utc;
  }>
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO backup_recovery_credentials (user_id, code_digest, created_at)
    VALUES (${input.userId}, ${input.codeDigest}, ${input.createdAt})
    ON CONFLICT (user_id) DO UPDATE SET code_digest = EXCLUDED.code_digest,
      created_at = EXCLUDED.created_at
  `;
}, Effect.orDie);
