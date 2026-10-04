import { DateTime, Effect, Schema } from "effect";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import { AuditUnavailable } from "~/shell/audit/contract";
import { OAuthRecentActivity } from "~/core/audit/contract";

export const recentOAuthActivity = (
  input: Readonly<{ db: D1Database; userId: string; connectionId: string; guard: OwnedStatement }>
): Effect.Effect<OAuthRecentActivity, AuditUnavailable> =>
  Effect.gen(function* () {
    const results = yield* Effect.tryPromise(() =>
      input.db.batch([
        input.db.prepare(`SELECT 1 AS live WHERE ${input.guard.sql}`).bind(...input.guard.params),
        input.db
          .prepare(
            `SELECT id,operation,outcome,occurred_at_ms FROM pat_audit WHERE user_id = ? AND oauth_connection_id = ? AND oauth_credential_id IS NOT NULL AND ${input.guard.sql} ORDER BY occurred_at_ms DESC,id DESC LIMIT 3`
          )
          .bind(input.userId, input.connectionId, ...input.guard.params),
      ])
    );
    if (results[0]?.results.length !== 1) return yield* new AuditUnavailable();
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          operation: Schema.String,
          outcome: Schema.Literals(["accepted", "rejected"]),
          occurred_at_ms: Schema.Int,
        })
      )
    )(results[1]?.results);
    return yield* Schema.decodeUnknownEffect(Schema.toType(OAuthRecentActivity))(
      rows.map((row) => ({
        id: row.id,
        operation: row.operation,
        outcome: row.outcome === "accepted" ? "succeeded" : "rejected",
        occurredAt: DateTime.makeUnsafe(row.occurred_at_ms),
      }))
    );
  }).pipe(Effect.catchCause(() => Effect.fail(new AuditUnavailable())));
