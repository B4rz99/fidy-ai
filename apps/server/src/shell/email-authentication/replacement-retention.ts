import { Crypto, DateTime, Effect, Layer, Option, Schedule, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  EmailReplacementRetentionClaimToken,
  EmailReplacementWorkflowId,
} from "~/core/email-authentication/model";
import { UserId } from "~/core/identity/reference";
import { withSubjectLock } from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";

const RetentionGatewayClaim = Schema.Struct({
  workflowId: EmailReplacementWorkflowId,
  userId: UserId,
  claimToken: EmailReplacementRetentionClaimToken,
});
type RetentionGatewayClaim = typeof RetentionGatewayClaim.Type;

const claimExpiredWorkflow = Effect.fn(function* (claimedAt: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const claimToken = EmailReplacementRetentionClaimToken.make(
    yield* crypto.randomUUIDv7.pipe(Effect.orDie)
  );
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: RetentionGatewayClaim,
    execute: () => sql`
      SELECT workflow_id AS "workflowId", user_id AS "userId", claim_token AS "claimToken"
      FROM fidy_claim_expired_email_replacement_workflow(
        ${claimedAt}, ${claimToken}, ${DateTime.add(claimedAt, { minutes: 2 })}
      )
    `,
  })(undefined).pipe(Effect.orDie);
});

const removeClaimedExpiredWorkflowInScope = Effect.fn(function* (
  claim: RetentionGatewayClaim,
  attemptedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const deleted = yield* sql`
    DELETE FROM email_replacement_workflows
    WHERE id = ${claim.workflowId} AND user_id = ${claim.userId}
      AND retention_claim_token = ${claim.claimToken}
      AND retention_claim_expires_at > ${attemptedAt} AND expires_at <= ${attemptedAt}
    RETURNING id
  `.pipe(Effect.orDie);
  return deleted.length === 1;
});

/**
 * Attempts to remove at most one expired replacement workflow. It returns `true` only when the
 * selected workflow is still expired, still belongs to the selected User, and is deleted under its
 * current lease; absent or stale work returns `false` without deleting a workflow.
 */
export const processOneReplacementRetention = Effect.fn("EmailReplacementRetention.processOne")(
  function* () {
    const attemptedAt = yield* DateTime.now;
    const gatewayClaim = yield* claimExpiredWorkflow(attemptedAt);
    if (Option.isNone(gatewayClaim)) return false;
    const claim = gatewayClaim.value;
    return yield* withUserTransaction(
      claim.userId,
      withSubjectLock(claim.userId, removeClaimedExpiredWorkflowInScope(claim, attemptedAt))
    );
  }
);

/** Owner operation for the approved gateway; rows exactly at the cutoff remain retained. */
export const removeReplacementLifecycleEventsBefore = Effect.fn(function* (cutoff: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    SELECT fidy_delete_verified_email_lifecycle_events_before(${cutoff}) AS deleted_count
  `;
});

/** Expired-workflow cleanup runs immediately and once per minute through its lease gateway. */
export const EmailReplacementRetentionLive = Layer.effectDiscard(
  processOneReplacementRetention().pipe(
    Effect.ignoreCause,
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped
  )
);
