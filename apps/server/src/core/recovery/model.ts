import { Schema } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";
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

/** Recovery-owned digest-only emergency credential for one stable User. */
export const BackupRecoveryCredential = Schema.Struct({
  userId: UserId,
  codeDigest: Schema.Uint8Array.check(sha256DigestLength),
  createdAt: UtcTimestamp,
}).annotate({ identifier: "BackupRecoveryCredential" });
export type BackupRecoveryCredential = typeof BackupRecoveryCredential.Type;
