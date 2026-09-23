import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { ActivePATMetadata, PATRecipientLabel, PATScopes, TokenShortId } from "~/core/tokens/model";
import type { UserId } from "~/core/identity/reference";
import { Unavailable } from "~/shell/public-http/contract";

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
    const rows = yield* SqlSchema.findAll({
      Request: Schema.Struct({ userId: Schema.String, current: Schema.Finite }),
      Result: PATMetadataRow,
      execute: (input) => sql`SELECT short_id,recipient_label,scopes_json,created_at_ms,
      last_used_at_ms,expires_at_ms FROM pats WHERE user_id = ${input.userId}
      AND revoked_at_ms IS NULL AND expires_at_ms > ${input.current}
      ORDER BY created_at_ms DESC LIMIT ${activeLimit + 1}`,
    })({ userId, current });
    if (rows.length > activeLimit) return yield* Effect.fail(queryUnavailable());
    const pats = yield* Effect.forEach(rows, decodeMetadata);
    return { data: { pats }, next: [] as const };
  }).pipe(Effect.mapError(queryUnavailable));
