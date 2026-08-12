import { Effect, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { MemoryId } from "~/core/memory/model";
import { MigrationSqlClient } from "~/shell/db/client";

/** Restores an empty Memory aggregate for an isolated real-Postgres test. */
export const truncateMemories = Effect.flatMap(
  MigrationSqlClient,
  (sql) => sql`TRUNCATE memories, memory_revisions`
).pipe(Effect.orDie);

/** Returns the User's current Memory revision, or zero before the first mutation. */
export const observeMemoryRevision = Effect.fn("observeMemoryRevision")(function* (userId: UserId) {
  const sql = yield* MigrationSqlClient;
  const row = yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ userId: UserId }),
    Result: Schema.Struct({ revision: Schema.BigIntFromString }),
    execute: (request) => sql`
      SELECT revision::text AS revision FROM memory_revisions WHERE user_id = ${request.userId}
    `,
  })({ userId }).pipe(Effect.orDie);
  return row._tag === "Some" ? row.value.revision : 0n;
});

/** Reports whether the identified User-owned Memory is physically present. */
export const observeMemoryExists = Effect.fn("observeMemoryExists")(function* (
  input: Readonly<{
    userId: UserId;
    id: MemoryId;
  }>
) {
  const sql = yield* MigrationSqlClient;
  const row = yield* SqlSchema.findOne({
    Request: Schema.Struct({ userId: UserId, id: MemoryId }),
    Result: Schema.Struct({ exists: Schema.Boolean }),
    execute: (request) => sql`
      SELECT EXISTS(
        SELECT 1 FROM memories WHERE user_id = ${request.userId} AND id = ${request.id}
      ) AS exists
    `,
  })(input).pipe(Effect.orDie);
  return row.exists;
});
