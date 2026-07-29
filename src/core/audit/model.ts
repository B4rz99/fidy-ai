import { Schema } from "effect";
import { AgentTokenId } from "~/core/_shared/agent-token";
import { UserId } from "~/core/_shared/user";

/** A stable UUID naming one append-only AuditLogEntry. */
export const AuditLogEntryId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("AuditLogEntryId")
);
export type AuditLogEntryId = typeof AuditLogEntryId.Type;

/** The canonical operation identity recorded as `<group>.<operation>`. */
export const CanonicalOperationId = Schema.String.check(
  Schema.isPattern(/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/)
).pipe(Schema.brand("CanonicalOperationId"));
export type CanonicalOperationId = typeof CanonicalOperationId.Type;

/** The recorded result of one attributable canonical call. */
export const AuditOutcome = Schema.Literals(["succeeded", "rejected", "failed"]);
export type AuditOutcome = typeof AuditOutcome.Type;

/**
 * Metadata-only evidence for one canonical call. It identifies the stable User,
 * AgentToken grant, operation, outcome, and UTC occurrence without retaining a
 * request, response, bearer, or financial value.
 */
export const AuditLogEntry = Schema.Struct({
  id: AuditLogEntryId,
  subjectUserId: UserId,
  tokenId: AgentTokenId,
  operation: CanonicalOperationId,
  outcome: AuditOutcome,
  occurredAt: Schema.DateTimeUtc,
}).annotate({ identifier: "AuditLogEntry" });
export type AuditLogEntry = typeof AuditLogEntry.Type;
