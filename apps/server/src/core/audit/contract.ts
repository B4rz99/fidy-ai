import { Schema } from "effect";
import { OAuthConnectionId, OAuthCredentialId } from "~/core/oauth-agents/contract";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import { UtcTimestamp } from "~/core/_shared/time";
import { UserId } from "~/core/identity/contract";
import { PATId } from "~/core/tokens/contract";
import { HostedAgentSessionId, TranscriptTurnId } from "~/core/agent/contract";
import { WebSessionId } from "~/core/web-session/contract";

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
  Schema.TaggedStruct("OAuthAgent", {
    connectionId: OAuthConnectionId,
    credentialId: OAuthCredentialId,
  }),
  Schema.TaggedStruct("WebSession", { webSessionId: WebSessionId }),
  Schema.TaggedStruct("HostedAgentSession", { hostedAgentSessionId: HostedAgentSessionId }),
  Schema.TaggedStruct("HostedTurn", { turnId: TranscriptTurnId }),
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

/** Bounded metadata-only activity for an OAuthConnection's settings projection, never call bodies. */
export const OAuthRecentActivity = Schema.Array(
  Schema.Struct({
    id: AuditLogEntryId,
    operation: AuditLogEntry.fields.operation,
    outcome: AuditLogEntry.fields.outcome,
    occurredAt: AuditLogEntry.fields.occurredAt,
  })
).check(Schema.isMaxLength(3));
export type OAuthRecentActivity = typeof OAuthRecentActivity.Type;

/** Maximum retained canonical outcomes disclosed in one PAT activity answer. */
export const maximumPATActivityEntries = 50;

/** Retained canonical PAT outcomes; no request, credential, attribution, or error prose is exposed. */
export const PATActivityEntry = Schema.Struct({
  operation: AuditLogEntry.fields.operation,
  outcome: AuditLogEntry.fields.outcome,
  occurredAt: AuditLogEntry.fields.occurredAt,
}).annotate({ identifier: "PATActivityEntry" });

/** A bounded retained history, never a claim that earlier activity did not occur. */
export const PATActivityHistory = Schema.Struct({
  entries: Schema.Array(PATActivityEntry).check(Schema.isMaxLength(maximumPATActivityEntries)),
  hasMore: Schema.Boolean,
  retainedSince: UtcTimestamp,
}).annotate({ identifier: "PATActivityHistory" });
export type PATActivityHistory = typeof PATActivityHistory.Type;
