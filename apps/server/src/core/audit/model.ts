import { Schema } from "effect";
import { TokenId } from "~/core/tokens/reference";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { UserId } from "~/core/identity/reference";
import { UtcTimestamp } from "~/core/_shared/time";

export { CanonicalOperationId } from "~/core/_shared/canonical-operation";

/** A stable UUID naming one append-only AuditLogEntry. */
export const AuditLogEntryId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("AuditLogEntryId"))
  .annotate({ identifier: "AuditLogEntryId" });
export type AuditLogEntryId = typeof AuditLogEntryId.Type;

/** The recorded result of one attributable canonical call. */
export const AuditOutcome = Schema.Literals(["succeeded", "rejected", "failed"]);
export type AuditOutcome = typeof AuditOutcome.Type;

/**
 * Metadata-only evidence for one canonical call. It identifies the stable User,
 * token grant, operation, outcome, and UTC occurrence without retaining a
 * request, response, bearer, or financial value.
 */
export const AuditLogEntry = Schema.Struct({
  id: AuditLogEntryId,
  subjectUserId: UserId,
  tokenId: TokenId,
  operation: CanonicalOperationId,
  outcome: AuditOutcome,
  occurredAt: UtcTimestamp,
}).annotate({ identifier: "AuditLogEntry" });
export type AuditLogEntry = typeof AuditLogEntry.Type;
