import { type DateTime, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";

/**
 * Ingestion-owned participant in an onboarding Consent revocation transaction.
 * The caller must already hold the User lock and shared external-effect gate. The operation
 * deletes personal IngestSamples for queued, deferred, or processing work, marks those receipts
 * revoked, clears their claims, and leaves completed Transaction or NeedsReview outcomes intact.
 */
export const revokePendingForwardedEmailsForConsentInScope = Effect.fn(
  "ForwardedEmailIngestion.revokePendingForConsentInScope"
)(function* (input: { readonly userId: UserId; readonly revokedAt: DateTime.Utc }) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    SELECT fidy_revoke_pending_forwarded_emails(${input.userId}, ${input.revokedAt})
  `.pipe(Effect.orDie);
});
