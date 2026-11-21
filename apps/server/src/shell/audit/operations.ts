import { DateTime, Effect, Schema } from "effect";
import {
  OAuthRecentActivity,
  PATActivityEntry,
  PATActivityHistory,
  maximumPATActivityEntries,
} from "~/core/audit/contract";

import type { CanonicalOperationId } from "~/core/canonical-operations/contract";
import type { OAuthAuthority } from "~/shell/oauth-agents/contract";
import type { OwnedStatement, PreparedRead } from "~/shell/owner-write/contract";
import {
  type AuditCredentialOperation,
  AuditUnavailable,
  type AuthorizedAuditCall,
  type OwnerAuditCall,
  type PATActivityAuthority,
  auditRetentionDays,
  utcDayMilliseconds,
} from "./contract";
import { authorizedCallStatement, ownerCallStatement } from "~/shell/audit/internal/recording";

import * as patEvidence from "~/shell/audit/internal/pat-evidence";

export { utcDayMilliseconds } from "./contract";

export const prepareOAuthActivityPage = (
  input: Readonly<{ connections: OwnedStatement; guard: OwnedStatement }>
): PreparedRead<ReadonlyMap<string, OAuthRecentActivity>, AuditUnavailable> => ({
  statement: {
    sql: `SELECT connections.id AS connectionId,
      (SELECT json_group_array(json_object('id',id,'operation',operation,'outcome',outcome,'occurred_at_ms',occurred_at_ms))
       FROM (SELECT id,operation,outcome,occurred_at_ms FROM audit_entries INDEXED BY audit_entries_oauth_activity
         WHERE record_type='credential_call' AND user_id=connections.user_id
           AND oauth_connection_id=connections.id AND oauth_credential_id IS NOT NULL
         ORDER BY occurred_at_ms DESC,id DESC LIMIT 3)) AS activity
      FROM (${input.connections.sql}) AS connections WHERE ${input.guard.sql}`,
    params: [...input.connections.params, ...input.guard.params],
  },
  decode: (raw) =>
    Effect.gen(function* () {
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            connectionId: Schema.String,
            activity: Schema.fromJsonString(
              Schema.Array(
                Schema.Struct({
                  id: Schema.String,
                  operation: Schema.String,
                  outcome: Schema.Literals(["accepted", "rejected"]),
                  occurred_at_ms: Schema.Int,
                })
              )
            ),
          })
        )
      )(raw);

      const entries = yield* Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(Schema.toType(OAuthRecentActivity))(
          row.activity.map((entry) => ({
            id: entry.id,
            operation: entry.operation,
            outcome: entry.outcome === "accepted" ? "succeeded" : "rejected",
            occurredAt: DateTime.makeUnsafe(entry.occurred_at_ms),
          }))
        ).pipe(
          Effect.map((activity): readonly [string, OAuthRecentActivity] => [
            row.connectionId,
            activity,
          ])
        )
      );

      return new Map(entries);
    }).pipe(Effect.catchCause((cause) => Effect.fail(new AuditUnavailable({ cause })))),
});

export const recordOAuthCall = (
  input: Readonly<{
    id: string;
    authority: OAuthAuthority;
    operation: AuditCredentialOperation | CanonicalOperationId;
    current: number;
    outcome: "accepted" | "rejected";
  }>
): OwnedStatement => ({
  sql: `INSERT INTO audit_entries(record_type,id,user_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms) SELECT 'credential_call',?,?,?,?,?,?,? FROM ${input.authority.table} WHERE ${input.authority.predicate}`,
  params: [
    input.id,
    input.authority.attribution.userId,
    input.authority.attribution.connectionId,
    input.authority.attribution.credentialId,
    input.operation,
    input.outcome,
    input.current,
    ...input.authority.bindings,
  ],
});

export const recordAuthorizedCall = (input: AuthorizedAuditCall): OwnedStatement =>
  authorizedCallStatement(input);

export const recordOwnerCall = (input: OwnerAuditCall): OwnedStatement => ownerCallStatement(input);

export const recordedPATCallProof: typeof patEvidence.recordedPATCallProof = (input) =>
  patEvidence.recordedPATCallProof(input);

export const recordedPATReplayCallProof: typeof patEvidence.recordedPATReplayCallProof = (input) =>
  patEvidence.recordedPATReplayCallProof(input);

export const recordSessionPATTransition: typeof patEvidence.recordSessionPATTransition = (input) =>
  patEvidence.recordSessionPATTransition(input);

export const recordClaimedPAT: typeof patEvidence.recordClaimedPAT = (input) =>
  patEvidence.recordClaimedPAT(input);

export const recordPATList: typeof patEvidence.recordPATList = (input) =>
  patEvidence.recordPATList(input);

export const recordOnePATRevocation: typeof patEvidence.recordOnePATRevocation = (input) =>
  patEvidence.recordOnePATRevocation(input);

export const recordAllPATRevocations: typeof patEvidence.recordAllPATRevocations = (input) =>
  patEvidence.recordAllPATRevocations(input);

export const recordCanonicalPATWork: typeof patEvidence.recordCanonicalPATWork = (input) =>
  patEvidence.recordCanonicalPATWork(input);

export const recordRejectedPATWork: typeof patEvidence.recordRejectedPATWork = (input) =>
  patEvidence.recordRejectedPATWork(input);

const ActivityRow = Schema.Struct({
  operation: PATActivityEntry.fields.operation,
  outcome: Schema.Literals(["accepted", "rejected"]),
  occurredAt: Schema.DateTimeUtcFromMillis,
});

export const preparePATActivity = (
  input: Readonly<{
    userId: string;
    grant: OwnedStatement;
    current: number;
    authority: PATActivityAuthority;
  }>
): PreparedRead<PATActivityHistory, AuditUnavailable> => {
  const cutoff = input.current - auditRetentionDays * utcDayMilliseconds;

  return {
    statement: {
      sql: `SELECT operation,outcome,occurred_at_ms AS occurredAt FROM audit_entries WHERE record_type='credential_call' AND user_id = ? AND pat_id = (${input.grant.sql})
        AND session_id IS NULL AND operation NOT LIKE 'pats.%' AND occurred_at_ms >= ?
        AND EXISTS (SELECT 1 FROM ${input.authority.table} WHERE ${input.authority.predicate})
        ORDER BY occurred_at_ms DESC, id DESC LIMIT ${maximumPATActivityEntries + 1}`,
      params: [input.userId, ...input.grant.params, cutoff, ...input.authority.bindings],
    },
    decode: (raw) =>
      Effect.gen(function* () {
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(ActivityRow).check(Schema.isMaxLength(maximumPATActivityEntries + 1))
        )(raw);

        return yield* Schema.decodeUnknownEffect(Schema.toType(PATActivityHistory))({
          entries: rows.slice(0, maximumPATActivityEntries).map((row) => ({
            ...row,
            outcome: row.outcome === "accepted" ? "succeeded" : "rejected",
          })),
          hasMore: rows.length > maximumPATActivityEntries,
          retainedSince: DateTime.makeUnsafe(cutoff),
        });
      }).pipe(Effect.mapError((cause) => new AuditUnavailable({ cause }))),
  };
};

export const recordPATActivityQuery = (
  input: Readonly<{
    id: string;
    userId: string;
    grant: OwnedStatement;
    current: number;
    authority: PATActivityAuthority;
  }>
): OwnedStatement => ({
  sql: `INSERT INTO audit_entries(record_type,id,user_id,${input.authority.table === "hosted_turns" ? "hosted_turn_id" : "session_id"},operation,outcome,occurred_at_ms) SELECT 'credential_call',?,user_id,id,'pats.getPATActivity',CASE WHEN EXISTS (${input.grant.sql}) THEN 'accepted' ELSE 'rejected' END,?
    FROM ${input.authority.table} WHERE ${input.authority.predicate}`,
  params: [input.id, ...input.grant.params, input.current, ...input.authority.bindings],
});
