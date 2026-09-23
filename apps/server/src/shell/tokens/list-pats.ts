import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ActivePATMetadata, PATRecipientLabel, PATScopes, TokenShortId } from "~/core/tokens/model";
import type { UserId } from "~/core/identity/reference";
import { Unavailable } from "~/shell/public-http/contract";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import type { FreshSessionSubject } from "~/shell/identity/browser-runtime";

const activeLimit = 100;
const PATMetadataRow = Schema.Struct({
  short_id: TokenShortId,
  recipient_label: PATRecipientLabel,
  scopes_json: Schema.String,
  created_at_ms: Schema.Finite,
  last_used_at_ms: Schema.NullOr(Schema.Finite),
  expires_at_ms: Schema.Finite,
});
const queryUnavailable = (): Unavailable =>
  Unavailable.make({
    error: {
      code: "unavailable",
      message: "PAT metadata is temporarily unavailable. Retry later.",
    },
    next: [],
  });

/** One bounded PAT metadata query, optionally rechecking its web caller at protected D1 work. */
export const patMetadataQuery = (
  userId: string,
  current: number,
  session: Option.Option<FreshSessionSubject>
): OwnedStatement => ({
  sql: `SELECT short_id,recipient_label,scopes_json,created_at_ms,last_used_at_ms,expires_at_ms
    FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = pats.user_id)
    ${
      Option.isSome(session)
        ? `AND EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ?
      AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`
        : ""
    }
    ORDER BY created_at_ms DESC LIMIT ${activeLimit + 1}`,
  params: [
    userId,
    current,
    ...(Option.isSome(session) ? [session.value.id, session.value.user_id, current, current] : []),
  ],
});

const decodeMetadata = (
  row: typeof PATMetadataRow.Type
): Effect.Effect<ActivePATMetadata, Schema.SchemaError> =>
  Effect.gen(function* () {
    const scopes = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PATScopes))(
      row.scopes_json
    );
    return yield* Schema.decodeUnknownEffect(Schema.toType(ActivePATMetadata))({
      shortId: row.short_id,
      recipientLabel: row.recipient_label,
      scopes,
      createdAt: DateTime.makeUnsafe(row.created_at_ms),
      lastUsedAt: Option.map(Option.fromNullishOr(row.last_used_at_ms), DateTime.makeUnsafe),
      expiresAt: DateTime.makeUnsafe(row.expires_at_ms),
    });
  });

/** Decode the same bounded metadata projection for both hosted and public Worker callers. */
export const patMetadataResponseFromRows = (
  raw: unknown
): Effect.Effect<
  {
    readonly data: { readonly pats: ReadonlyArray<ActivePATMetadata> };
    readonly next: ReadonlyArray<never>;
  },
  Unavailable
> =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(PATMetadataRow))(raw);
    if (rows.length > activeLimit) return yield* Effect.fail(queryUnavailable());
    const pats = yield* Effect.forEach(rows, decodeMetadata);
    return { data: { pats }, next: [] as const };
  }).pipe(Effect.mapError(queryUnavailable));

/** Load only active, User-owned PAT metadata; malformed or excessive stored rows fail closed. */
export const listPATsResponse = (
  userId: UserId
): Effect.Effect<
  {
    readonly data: { readonly pats: ReadonlyArray<ActivePATMetadata> };
    readonly next: ReadonlyArray<never>;
  },
  Unavailable,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const sql = yield* SqlClient.SqlClient;
    const query = patMetadataQuery(userId, current, Option.none());
    const rows = yield* sql.unsafe<Record<string, unknown>>(query.sql, query.params);
    return yield* patMetadataResponseFromRows(rows);
  }).pipe(Effect.mapError(queryUnavailable));
