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

const evidenceQuery = `SELECT id,user_id AS subjectUserId,session_id AS sessionId,
  pat_id AS patId,hosted_turn_id AS hostedTurnId,oauth_connection_id AS oauthConnectionId,
  oauth_credential_id AS oauthCredentialId,operation,
  CASE WHEN outcome IN ('success','accepted','replaced') THEN 'succeeded' ELSE 'rejected' END AS outcome,
  occurred_at_ms AS occurredAt FROM audit_entries
  WHERE user_id=? AND record_type IN ('session_call','credential_call','insight_call')
  ORDER BY occurred_at_ms,id LIMIT ?`;

const callerOf = (row: typeof Row.Type): AuditCaller => {
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
      try: () => database.prepare(evidenceQuery).bind(request.userId, request.limit).all(),
      catch: () => new AuditUnavailable(),
    });
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(result.results);
    return yield* Effect.try({
      try: () =>
        rows.map((row) =>
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
    const result = yield* Effect.tryPromise({
      try: () =>
        database
          .prepare(
            `SELECT id,user_id AS subjectUserId,operation,
            CASE WHEN outcome='success' THEN 'succeeded' ELSE 'rejected' END AS outcome,
            occurred_at_ms AS occurredAt FROM audit_entries WHERE record_type='publication' AND user_id=?
            ORDER BY occurred_at_ms,id LIMIT ?`
          )
          .bind(request.userId, request.limit)
          .all<unknown>(),
      catch: () => new AuditUnavailable(),
    });
    return yield* Schema.decodeUnknownEffect(Schema.Array(PublicationRow))(result.results);
  }).pipe(Effect.mapError(() => new AuditUnavailable()));
