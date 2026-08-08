import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { DashboardDocument, WidgetId } from "~/core/dashboard/model";
import { advisoryLockKey, withUserLockInScope } from "~/shell/db/advisory-lock";
import { withUserTransaction } from "~/shell/db/user-transaction";

const DashboardRow = Schema.Struct({
  document: DashboardDocument,
});

const DashboardWrite = Schema.Struct({
  userId: UserId,
  document: DashboardDocument,
});

/** Acquires the Dashboard advisory lock inside the caller's active User-scoped transaction. */
export const withDashboardLockInScope = Effect.fn("withDashboardLockInScope")(function* <A, E, R>(
  userId: UserId,
  body: Effect.Effect<A, E, R>
) {
  return yield* withUserLockInScope(advisoryLockKey.dashboard(userId), body);
});

/**
 * Runs one dashboard initialization or edit under its User-scoped lock. The lock covers the
 * supplied body and cannot be acquired independently of its transaction.
 */
export const withDashboardLock = Effect.fn("withDashboardLock")(function* <A, E, R>(
  userId: UserId,
  body: Effect.Effect<A, E, R>
) {
  return yield* withUserTransaction(userId, withDashboardLockInScope(userId, body));
});

/** Reads and schema-decodes one User-owned JSONB document in the active User transaction. */
export const findDashboardInScope = (
  userId: UserId
): Effect.Effect<Option.Option<DashboardDocument>, never, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: UserId,
      Result: DashboardRow,
      execute: (owner) => sql`
        SELECT document
        FROM dashboards
        WHERE user_id = ${owner}
      `,
    })(userId)
  ).pipe(Effect.map(Option.map((row) => row.document)), Effect.orDie);

/** Generates the UUID embedded in a first-use default without ambient randomness. */
export const generateDashboardWidgetId = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ id: WidgetId }),
    execute: () => sql`SELECT gen_random_uuid() AS id`,
  })(undefined)
).pipe(
  Effect.map((row) => row.id),
  Effect.orDie
);

/** Inserts the first schema-encoded document inside the caller's active User transaction. */
export const insertDashboardInScope = Effect.fn("insertDashboardInScope")(function* (
  userId: UserId,
  document: DashboardDocument
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: DashboardWrite,
    Result: DashboardRow,
    execute: (row) => sql`
      INSERT INTO dashboards (user_id, document)
      VALUES (${row.userId}, ${row.document}::jsonb)
      RETURNING document
    `,
  })({ userId, document }).pipe(
    Effect.map((row) => row.document),
    Effect.orDie
  );
});

/** Replaces the locked DashboardDocument inside the caller's active User transaction. */
export const updateDashboardInScope = Effect.fn("updateDashboardInScope")(function* (
  userId: UserId,
  document: DashboardDocument
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: DashboardWrite,
    Result: DashboardRow,
    execute: (row) => sql`
      UPDATE dashboards
      SET document = ${row.document}::jsonb, updated_at = now()
      WHERE user_id = ${row.userId}
      RETURNING document
    `,
  })({ userId, document }).pipe(
    Effect.map((row) => row.document),
    Effect.orDie
  );
});
