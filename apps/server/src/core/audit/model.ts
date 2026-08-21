import { Schema } from "effect";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { UtcTimestamp } from "~/core/_shared/time";
import { UserId } from "~/core/identity/reference";
import { PATId } from "~/core/tokens/reference";
import { HostedAgentSessionId } from "~/core/transcript/reference";

export { CanonicalOperationId } from "~/core/_shared/canonical-operation";

/** A stable UUID naming one append-only AuditLogEntry. */
export const AuditLogEntryId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("AuditLogEntryId"))
  .annotate({ identifier: "AuditLogEntryId" });
export type AuditLogEntryId = typeof AuditLogEntryId.Type;

/** The recorded result of one attributable canonical call. */
export const AuditOutcome = Schema.Literals(["succeeded", "rejected", "failed"]);
export type AuditOutcome = typeof AuditOutcome.Type;

/** Exactly one credential-neutral source of canonical-call authority. */
export const AuditCaller = Schema.Union([
  Schema.TaggedStruct("PAT", { patId: PATId }),
  Schema.TaggedStruct("HostedAgentSession", { hostedAgentSessionId: HostedAgentSessionId }),
]).annotate({ identifier: "AuditCaller" });
export type AuditCaller = typeof AuditCaller.Type;

/**
 * Metadata-only evidence for one canonical call. It identifies the stable User,
 * authority source, operation, outcome, and UTC occurrence without retaining a
 * request, response, bearer, or financial value.
 */
export const AuditLogEntry = Schema.Struct({
  id: AuditLogEntryId,
  subjectUserId: UserId,
  caller: AuditCaller,
  operation: CanonicalOperationId,
  outcome: AuditOutcome,
  occurredAt: UtcTimestamp,
}).annotate({ identifier: "AuditLogEntry" });
export type AuditLogEntry = typeof AuditLogEntry.Type;
