import { Schema } from "effect";
import { OAuthConnectionId, OAuthCredentialId } from "~/core/oauth-agents/contract";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import { UtcTimestamp } from "~/core/_shared/time";
import { UserId } from "~/core/identity/contract";
import { PATId } from "~/core/tokens/contract";
import { HostedAgentSessionId, TranscriptTurnId } from "~/core/agent/contract";
import { WebSessionId } from "~/core/web-session/contract";

export const AuditLogEntryId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("AuditLogEntryId"))
  .annotate({ identifier: "AuditLogEntryId" });

export type AuditLogEntryId = typeof AuditLogEntryId.Type;

export const AuditOutcome = Schema.Literals(["succeeded", "rejected", "failed"]);

export type AuditOutcome = typeof AuditOutcome.Type;

export const PatAuditCaller = Schema.TaggedStruct("PAT", { patId: PATId });

export const OAuthAuditCaller = Schema.TaggedStruct("OAuthAgent", {
  connectionId: OAuthConnectionId,
  credentialId: OAuthCredentialId,
});

export const WebSessionAuditCaller = Schema.TaggedStruct("WebSession", {
  webSessionId: WebSessionId,
});

export const HostedAuditCaller = Schema.TaggedStruct("HostedAgentSession", {
  hostedAgentSessionId: HostedAgentSessionId,
});

export const HostedTurnAuditCaller = Schema.TaggedStruct("HostedTurn", {
  turnId: TranscriptTurnId,
});

export const AuditCaller = Schema.Union([
  PatAuditCaller,
  OAuthAuditCaller,
  WebSessionAuditCaller,
  HostedAuditCaller,
  HostedTurnAuditCaller,
]).annotate({ identifier: "AuditCaller" });

export type AuditCaller = typeof AuditCaller.Type;

export const AuditLogEntry = Schema.Struct({
  id: AuditLogEntryId,
  subjectUserId: UserId,
  caller: AuditCaller,
  operation: CanonicalOperationId,
  outcome: AuditOutcome,
  occurredAt: UtcTimestamp,
}).annotate({ identifier: "AuditLogEntry" });

export type AuditLogEntry = typeof AuditLogEntry.Type;

export const OAuthRecentActivity = Schema.Array(
  Schema.Struct({
    id: AuditLogEntryId,
    operation: AuditLogEntry.fields.operation,
    outcome: AuditLogEntry.fields.outcome,
    occurredAt: AuditLogEntry.fields.occurredAt,
  })
).check(Schema.isMaxLength(3));

export type OAuthRecentActivity = typeof OAuthRecentActivity.Type;

export const maximumPATActivityEntries = 50;

export const PATActivityEntry = Schema.Struct({
  operation: AuditLogEntry.fields.operation,
  outcome: AuditLogEntry.fields.outcome,
  occurredAt: AuditLogEntry.fields.occurredAt,
}).annotate({ identifier: "PATActivityEntry" });

export const PATActivityHistory = Schema.Struct({
  entries: Schema.Array(PATActivityEntry).check(Schema.isMaxLength(maximumPATActivityEntries)),
  hasMore: Schema.Boolean,
  retainedSince: UtcTimestamp,
}).annotate({ identifier: "PATActivityHistory" });

export type PATActivityHistory = typeof PATActivityHistory.Type;
