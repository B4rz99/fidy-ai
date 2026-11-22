import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Schema } from "effect";
import { ProCursor } from "../../../src/shell/pro-grants/contract";
import { UserId } from "../../../src/core/identity/contract";
import { betaPageSize, betaStatus } from "../../beta-pro/contract";

export const readBetaRegistry = Effect.fn(
  function* (request: Request) {
    const cursor = yield* Schema.decodeUnknownEffect(Schema.NullOr(ProCursor))(
      yield* Effect.tryPromise(() => request.json())
    );

    const sql = yield* SqliteClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const through =
          cursor?.through ??
          (yield* Schema.decodeUnknownEffect(Schema.Struct({ last: Schema.Int }))(
            (yield* sql`SELECT coalesce(max(rowid),0) AS last FROM lifetime_registry`)[0]
          )).last;

        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ position: Schema.Int, user_id: UserId, live: Schema.Int }))
        )(
          yield* sql`SELECT rowid AS position,user_id,(retired=0 AND erasure_reference IS NULL) AS live FROM lifetime_registry WHERE rowid>${cursor?.after ?? 0} AND rowid<=${through} ORDER BY rowid LIMIT ${betaPageSize + 1}`
        );

        const page = rows.slice(0, betaPageSize);
        const after = page.at(-1)?.position;

        return Response.json({
          users: page.filter((row) => row.live === 1).map((row) => row.user_id),
          next: rows.length > page.length && after !== undefined ? { after, through } : null,
        });
      })
    );
  },
  Effect.tapCause(Effect.logDebug),
  Effect.orElseSucceed(() => new Response(null, { status: betaStatus.unavailable }))
);
