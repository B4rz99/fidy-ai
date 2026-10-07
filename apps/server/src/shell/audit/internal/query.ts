import { DateTime, Effect, Option, Schema } from "effect";
import { TranscriptTurnId } from "~/core/agent/contract";
import { type AuditCaller, AuditLogEntry } from "~/core/audit/contract";

import { OAuthConnectionId, OAuthCredentialId } from "~/core/oauth-agents/contract";
import { UserId } from "~/core/identity/contract";
import { PATId } from "~/core/tokens/contract";
import { WebSessionId } from "~/core/web-session/contract";
import {
  AuditPublicationEvidence,
  type AuditQuery,
  AuditUnavailable,
} from "~/shell/audit/contract";

const Query = Schema.Struct({
  userId: UserId,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
});
const Row = Schema.Struct({
  id: AuditLogEntry.fields.id,
  subjectUserId: AuditLogEntry.fields.subjectUserId,
  sessionId: Schema.OptionFromNullOr(WebSessionId),
  patId: Schema.OptionFromNullOr(PATId),
  hostedTurnId: Schema.OptionFromNullOr(TranscriptTurnId),
  oauthConnectionId: Schema.OptionFromOptionalKey(Schema.NullOr(OAuthConnectionId)),
  oauthCredentialId: Schema.OptionFromOptionalKey(Schema.NullOr(OAuthCredentialId)),
  operation: AuditLogEntry.fields.operation,
  outcome: AuditLogEntry.fields.outcome,
  occurredAt: Schema.Int,
});

const projection = (
  table: string,
  caller: "session" | "pat" | "insight",
  outcome: string
): string =>
  `SELECT id, user_id AS subjectUserId, session_id AS sessionId, ${caller === "pat" ? "pat_id" : "NULL"} AS patId,
    ${caller === "insight" || caller === "pat" ? "hosted_turn_id" : "NULL"} AS hostedTurnId,
    ${caller === "pat" ? "oauth_connection_id AS oauthConnectionId, oauth_credential_id AS oauthCredentialId," : ""}
    operation, ${outcome} AS outcome, occurred_at_ms AS occurredAt FROM ${table} WHERE user_id = ?
    ORDER BY occurred_at_ms, id LIMIT ?`;
const evidenceQueries = [
  projection(
    "transaction_audit",
    "session",
    "CASE WHEN outcome = 'success' THEN 'succeeded' ELSE 'rejected' END"
  ),
  projection(
    "pat_audit",
    "pat",
    "CASE WHEN outcome = 'accepted' THEN 'succeeded' ELSE 'rejected' END"
  ),
  projection(
    "category_audit",
    "session",
    "CASE WHEN outcome = 'success' THEN 'succeeded' ELSE 'rejected' END"
  ),
  projection(
    "memory_audit",
    "session",
    "CASE WHEN outcome = 'success' THEN 'succeeded' ELSE 'rejected' END"
  ),
  projection(
    "budget_audit",
    "session",
    "CASE WHEN outcome = 'accepted' THEN 'succeeded' ELSE 'rejected' END"
  ),
  projection(
    "dashboard_audit",
    "session",
    "CASE WHEN outcome = 'accepted' THEN 'succeeded' ELSE 'rejected' END"
  ),
  projection(
    "insight_audit",
    "insight",
    "CASE WHEN outcome = 'accepted' THEN 'succeeded' ELSE 'rejected' END"
  ),
  `SELECT id, user_id AS subjectUserId, session_id AS sessionId, NULL AS patId, NULL AS hostedTurnId,
    'emailAuthentication.' || operation AS operation,
    CASE WHEN outcome IN ('accepted', 'replaced') THEN 'succeeded' ELSE 'rejected' END AS outcome,
    occurred_at_ms AS occurredAt FROM email_replacement_audit WHERE user_id = ? ORDER BY occurred_at_ms, id LIMIT ?`,
];

const callerOf = (row: typeof Row.Type): AuditCaller => {
  // A lifecycle transition may identify a target PAT as well as its acting session.
  if (Option.isSome(row.sessionId)) {
    return { _tag: "WebSession", webSessionId: row.sessionId.value };
  }
  if (Option.isSome(row.hostedTurnId)) {
    return { _tag: "HostedTurn", turnId: row.hostedTurnId.value };
  }
  if (Option.isSome(row.patId)) return { _tag: "PAT", patId: row.patId.value };
  if (
    Option.isSome(row.oauthConnectionId) &&
    row.oauthConnectionId.value !== null &&
    Option.isSome(row.oauthCredentialId) &&
    row.oauthCredentialId.value !== null
  ) {
    return {
      _tag: "OAuthAgent",
      connectionId: row.oauthConnectionId.value,
      credentialId: row.oauthCredentialId.value,
    };
  }
  throw new Error("Audit evidence has no caller");
};

/** Reads attributable calls only; supporting publication evidence is not a second canonical call. */
export const queryEvidence = ({
  database,
  input,
}: Readonly<{ database: D1Database; input: AuditQuery }>): Effect.Effect<
  ReadonlyArray<AuditLogEntry>,
  AuditUnavailable
> =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeEffect(Query)(input);
    const result = yield* Effect.tryPromise({
      try: () =>
        database.batch(
          evidenceQueries.map((sql) => database.prepare(sql).bind(request.userId, request.limit))
        ),
      catch: () => new AuditUnavailable(),
    });
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(
      result.flatMap((batch) => batch.results)
    );
    return yield* Effect.try({
      try: () =>
        rows
          .toSorted(
            (left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id)
          )
          .slice(0, request.limit)
          .map((row) =>
            AuditLogEntry.make({
              id: row.id,
              subjectUserId: row.subjectUserId,
              caller: callerOf(row),
              operation: row.operation,
              outcome: row.outcome,
              occurredAt: DateTime.makeUnsafe(row.occurredAt),
            })
          ),
      catch: () => new AuditUnavailable(),
    });
  }).pipe(Effect.mapError(() => new AuditUnavailable()));

const PublicationRow = Schema.Struct({
  ...AuditPublicationEvidence.fields,
  occurredAt: Schema.DateTimeUtcFromMillis,
});
/** Observes supporting publication/review metadata without inventing a credential absent from retained evidence. */
export const queryPublications = ({
  database,
  input,
}: Readonly<{ database: D1Database; input: AuditQuery }>): Effect.Effect<
  ReadonlyArray<AuditPublicationEvidence>,
  AuditUnavailable
> =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeEffect(Query)(input);
    const projection = (table: string): string => `SELECT id, user_id AS subjectUserId, operation,
      CASE WHEN outcome = 'success' THEN 'succeeded' ELSE 'rejected' END AS outcome, occurred_at_ms AS occurredAt
      FROM ${table} WHERE user_id = ?`;
    const result = yield* Effect.tryPromise({
      try: () =>
        database
          .prepare(
            `SELECT * FROM (${projection("statement_submission_audit")} UNION ALL ${projection("statement_review_audit")} UNION ALL ${projection("statement_clarification_audit")}) ORDER BY occurredAt, id LIMIT ?`
          )
          .bind(request.userId, request.userId, request.userId, request.limit)
          .all<unknown>(),
      catch: () => new AuditUnavailable(),
    });
    return yield* Schema.decodeUnknownEffect(Schema.Array(PublicationRow))(result.results);
  }).pipe(Effect.mapError(() => new AuditUnavailable()));
