import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  type ActivePATList,
  ActivePATMetadata,
  PATRecipientLabel,
  PATScopes,
  TokenShortId,
} from "~/core/tokens/contract";
import type { UserId } from "~/core/identity/reference";
import { Unavailable } from "~/shell/public-http/contract";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import { protectConsentStatement } from "~/shell/consent/operations";
import type { FreshSessionSubject } from "~/shell/web-session/contract";
import { liveSessionConditions } from "~/shell/web-session/operations";

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
export const patMetadataQuery = ({
  userId,
  current,
  session,
}: Readonly<{
  userId: string;
  current: number;
  session: Option.Option<FreshSessionSubject>;
}>): OwnedStatement => {
  const protectedQuery = protectConsentStatement({
    statement: {
      sql: `SELECT short_id,recipient_label,scopes_json,created_at_ms,last_used_at_ms,expires_at_ms
        FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?`,
      params: [userId, current],
    },
    subject: { _tag: "Owner", column: "pats.user_id" },
    requirement: "unrevoked",
  });
  const sessionGuard = Option.map(session, (subject) =>
    liveSessionConditions({ session: subject, current })
  );
  return {
    sql: `${protectedQuery.sql}
      ${Option.isSome(sessionGuard) ? `AND ${sessionGuard.value.sql}` : ""}
      ORDER BY created_at_ms DESC LIMIT ${activeLimit + 1}`,
    params: [
      ...protectedQuery.params,
      ...(Option.isSome(sessionGuard) ? sessionGuard.value.params : []),
    ],
  };
};

const decodeMetadata = (
  row: typeof PATMetadataRow.Type
): Effect.Effect<ActivePATMetadata, Schema.SchemaError> =>
  Effect.gen(function* () {
    const scopes = yield* Schema.decodeEffect(Schema.fromJsonString(PATScopes))(row.scopes_json);
    return yield* Schema.decodeEffect(Schema.toType(ActivePATMetadata))({
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
    readonly data: ActivePATList;
    readonly next: ReadonlyArray<never>;
  },
  Unavailable
> =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(PATMetadataRow))(raw);
    if (rows.length > activeLimit) return yield* queryUnavailable();
    const pats = yield* Effect.forEach(rows, decodeMetadata);
    return { data: { pats }, next: [] as const };
  }).pipe(Effect.mapError(queryUnavailable));

/** Load only active, User-owned PAT metadata; malformed or excessive stored rows fail closed. */
export const listPATsResponse = (
  userId: UserId
): Effect.Effect<
  {
    readonly data: ActivePATList;
    readonly next: ReadonlyArray<never>;
  },
  Unavailable,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const sql = yield* SqlClient.SqlClient;
    const query = patMetadataQuery({ userId, current, session: Option.none() });
    const rows = yield* sql.unsafe<Record<string, unknown>>(query.sql, query.params);
    return yield* patMetadataResponseFromRows(rows);
  }).pipe(Effect.mapError(queryUnavailable));
