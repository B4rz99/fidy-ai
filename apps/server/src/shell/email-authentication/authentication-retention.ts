import { Crypto, DateTime, Effect, Layer, Option, Schedule, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  BrowserPairingEmailRetentionClaimToken,
  BrowserPairingEmailWorkflowId,
} from "~/core/email-authentication/model";
import { UserId } from "~/core/identity/reference";
import { withSubjectLock } from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";

const RetentionClaim = Schema.Struct({
  workflowId: BrowserPairingEmailWorkflowId,
  userId: UserId,
  claimToken: BrowserPairingEmailRetentionClaimToken,
});
type RetentionClaim = typeof RetentionClaim.Type;

const claimExpiredWorkflow = Effect.fn(function* (claimedAt: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const token = BrowserPairingEmailRetentionClaimToken.make(
    yield* crypto.randomUUIDv7.pipe(Effect.orDie)
  );
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: RetentionClaim,
    execute: () => sql`
      SELECT workflow_id AS "workflowId", user_id AS "userId", claim_token AS "claimToken"
      FROM fidy_claim_expired_browser_pairing_email_workflow(
        ${claimedAt}, ${token}, ${DateTime.add(claimedAt, { minutes: 2 })}
      )
    `,
  })(undefined).pipe(Effect.orDie);
});

const deleteClaimedWorkflowInScope = Effect.fn(function* (claim: RetentionClaim) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DELETE FROM browser_pairing_email_workflows
    WHERE id = ${claim.workflowId} AND user_id = ${claim.userId}
      AND retention_claim_token = ${claim.claimToken}
  `.pipe(Effect.orDie);
});

/** Purges at most one expired User-owned email-login workflow. */
export const purgeOneExpiredBrowserPairingEmailWorkflow = Effect.fn(function* () {
  const now = yield* DateTime.now;
  const claim = yield* claimExpiredWorkflow(now);
  if (Option.isNone(claim)) return false;
  yield* withUserTransaction(
    claim.value.userId,
    withSubjectLock(claim.value.userId, deleteClaimedWorkflowInScope(claim.value))
  );
  return true;
});

/** Purges one bounded batch of expired anonymous admission evidence. */
export const purgeBrowserPairingEmailAdmissionEvidence = Effect.fn(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  yield* sql`SELECT fidy_purge_email_pairing_login_admission_evidence(${now})`.pipe(Effect.orDie);
});

/** Production retention loop for short-lived authentication state and evidence. */
export const BrowserPairingEmailRetentionLive = Layer.effectDiscard(
  Effect.all(
    [
      purgeOneExpiredBrowserPairingEmailWorkflow().pipe(
        Effect.delay("1 second"),
        Effect.forever,
        Effect.forkScoped
      ),
      purgeBrowserPairingEmailAdmissionEvidence().pipe(
        Effect.repeat(Schedule.spaced("1 minute")),
        Effect.forkScoped
      ),
    ],
    { discard: true }
  )
);
