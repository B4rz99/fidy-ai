import { Effect, Option, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { Memory, MemoryId } from "~/core/memory/model";

const MemoryWithoutTimestamps = Memory.mapFields(Struct.omit(["createdAt", "updatedAt"]));
const MemoryRow = Schema.Struct({
  ...MemoryWithoutTimestamps.fields,
  createdAt: Schema.DateTimeUtcFromDate,
  updatedAt: Schema.DateTimeUtcFromDate,
});
const MemoryLookup = Schema.Struct({ userId: UserId });
const MemoryWrite = Schema.Struct({
  userId: UserId,
  ...MemoryWithoutTimestamps.fields,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
const MemoryReplacement = Schema.Struct({
  userId: UserId,
  ...Memory.mapFields(Struct.omit(["createdAt"])).fields,
});
const MemoryIdentity = Schema.Struct({
  userId: UserId,
  ...Memory.mapFields(Struct.pick(["id"])).fields,
});

const decodeMemory = (row: typeof MemoryRow.Type): Memory =>
  Memory.make({
    ...row,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

/** Lists every current Memory inside the active User scope in stable recall order. */
export const selectMemoriesInScope = Effect.fn("selectMemoriesInScope")(function* (userId: UserId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* SqlSchema.findAll({
    Request: MemoryLookup,
    Result: MemoryRow,
    execute: (request) => sql`
      SELECT id, text, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM memories
      WHERE user_id = ${request.userId}
      ORDER BY created_at, id
    `,
  })({ userId }).pipe(Effect.orDie);
  const memories: ReadonlyArray<Memory> = rows.map(decodeMemory);
  return memories;
});

/** Inserts one admitted Memory inside the caller-owned User transaction. */
export const insertMemoryInScope = Effect.fn("insertMemoryInScope")(function* (
  userId: UserId,
  memory: Memory
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOne({
    Request: MemoryWrite,
    Result: MemoryRow,
    execute: (request) => sql`
      INSERT INTO memories (user_id, id, text, created_at, updated_at)
      VALUES (${request.userId}, ${request.id}, ${request.text}, ${request.createdAt}, ${request.updatedAt})
      RETURNING id, text, created_at AS "createdAt", updated_at AS "updatedAt"
    `,
  })({ userId, ...memory }).pipe(Effect.orDie);
  return decodeMemory(row);
});

/** Atomically replaces one User-owned Memory; foreign or absent returns None. */
export const updateMemoryInScope = Effect.fn("updateMemoryInScope")(function* (
  userId: UserId,
  memory: Memory
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOneOption({
    Request: MemoryReplacement,
    Result: MemoryRow,
    execute: (request) => sql`
      UPDATE memories SET text = ${request.text}, updated_at = ${request.updatedAt}
      WHERE user_id = ${request.userId} AND id = ${request.id}
      RETURNING id, text, created_at AS "createdAt", updated_at AS "updatedAt"
    `,
  })({ userId, id: memory.id, text: memory.text, updatedAt: memory.updatedAt }).pipe(Effect.orDie);
  return Option.map(row, decodeMemory);
});

/** Physically removes one User-owned Memory; foreign and absent return None. */
export const deleteMemoryInScope = Effect.fn("deleteMemoryInScope")(function* (
  userId: UserId,
  id: MemoryId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: MemoryIdentity,
    Result: Schema.Struct({ id: MemoryId }),
    execute: (request) => sql`
      DELETE FROM memories WHERE user_id = ${request.userId} AND id = ${request.id} RETURNING id
    `,
  })({ userId, id }).pipe(Effect.map(Option.map((row) => row.id)), Effect.orDie);
});
