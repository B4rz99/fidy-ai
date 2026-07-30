import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/_shared/user";
import { DashboardDocument, WidgetId } from "~/core/dashboard/model";

const PersistedDashboard = Schema.fromJsonString(DashboardDocument);

const DashboardRow = Schema.Struct({
  document: PersistedDashboard,
});

const DashboardWrite = Schema.Struct({
  userId: UserId,
  document: PersistedDashboard,
});

/** Serializes first-use initialization and edits even before a User has a row to lock. */
export const lockDashboard = (userId: UserId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 15))`
  ).pipe(Effect.asVoid, Effect.orDie);

/** Reads and schema-decodes one User-owned JSONB document. */
export const findDashboard = (userId: UserId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: UserId,
      Result: DashboardRow,
      execute: (owner) => sql`
        SELECT document::text AS "document"
        FROM dashboards
        WHERE user_id = ${owner}
        FOR UPDATE
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

/** Inserts the first schema-encoded document after the handler acquired the User lock. */
export const insertDashboard = Effect.fn("insertDashboard")(function* (
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
      RETURNING document::text AS "document"
    `,
  })({ userId, document }).pipe(
    Effect.map((row) => row.document),
    Effect.orDie
  );
});

/** Replaces only the explicit User's locked document with a schema-encoded candidate. */
export const updateDashboard = Effect.fn("updateDashboard")(function* (
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
      RETURNING document::text AS "document"
    `,
  })({ userId, document }).pipe(
    Effect.map((row) => row.document),
    Effect.orDie
  );
});
