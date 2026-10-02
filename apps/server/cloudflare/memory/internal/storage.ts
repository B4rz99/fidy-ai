import { type TransactionCaller, callerAuthority } from "../../canonical-work/operations";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  Memory,
  MemoryId,
  MemoryText,
  maximumAggregateMemoryTokens,
} from "@fidy/server/memory-contract";
import type { OwnedStatement } from "../../../src/shell/_shared/owned-statement";
/** The exact Memory row projection every owner query returns, kept in one place. */
const memoryRowColumns = "id,text,created_at,updated_at";

/**
 * Every current Memory of one explicit User in stable ascending creation and identity order —
 * exactly the order the aggregate capacity is counted in. The projection is guarded by the live
 * credential so a revoked or withdrawn authority cannot read. Supply an owner-published query
 * projecting semantic userId; it is correlated to this same User at execution, never trusted as
 * a previously checked permission or allowed to release another User's Memory.
 */
export const memoryRowsQuery = ({
  userId,
  authority,
}: Readonly<{ userId: string; authority: OwnedStatement }>): OwnedStatement => ({
  sql: `SELECT ${memoryRowColumns} FROM memories
    WHERE user_id = ? AND EXISTS (SELECT 1 FROM (${authority.sql}) AS memory_authority WHERE memory_authority.userId = memories.user_id)
    ORDER BY created_at, id`,
  params: [userId, ...authority.params],
});

/**
 * One explicit owner's Memory by stable identity, or no row when it is absent or foreign. The
 * readback runs after a guarded write already proved the caller's authority, so this projection
 * stays unguarded and reuses the same row shape as the full owner query.
 */
export const memoryRowQuery = ({
  userId,
  id,
}: Readonly<{ userId: string; id: string }>): OwnedStatement => ({
  sql: `SELECT ${memoryRowColumns} FROM memories WHERE user_id = ? AND id = ?`,
  params: [userId, id],
});

const MemoryRow = Schema.Struct({
  id: MemoryId,
  text: MemoryText,
  created_at: Schema.String,
  updated_at: Schema.String,
});

/** Rebuild untrusted D1 rows into canonical current Memories, or reject the whole projection. */
export const memoriesFromRows = (rows: unknown): Option.Option<ReadonlyArray<Memory>> => {
  const decoded = Schema.decodeUnknownOption(Schema.Array(MemoryRow))(rows);
  return Option.flatMap(decoded, (values) => {
    const memories: Array<Memory> = [];
    for (const row of values) {
      const memory = Schema.decodeOption(Memory)({
        id: row.id,
        text: row.text,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
      if (Option.isNone(memory)) return Option.none<ReadonlyArray<Memory>>();
      memories.push(memory.value);
    }
    return Option.some(memories);
  });
};

export const insertMemory = ({
  db,
  subject,
  candidate,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  candidate: Memory;
  current: number;
}>): D1PreparedStatement => {
  const authority = callerAuthority({ subject, current });
  return db
    .prepare(`INSERT INTO memories (id, user_id, text, created_at, updated_at)
      SELECT ?, user_id, ?, ?, ? FROM ${authority.table} WHERE ${authority.predicate}`)
    .bind(
      candidate.id,
      candidate.text,
      DateTime.formatIso(candidate.createdAt),
      DateTime.formatIso(candidate.updatedAt),
      ...authority.bindings
    );
};

export const replaceMemory = ({
  db,
  subject,
  candidate,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  candidate: Memory;
  current: number;
}>): D1PreparedStatement => {
  const authority = callerAuthority({ subject, current });
  return db
    .prepare(`UPDATE memories SET text = ?, updated_at = ? WHERE user_id = ? AND id = ?
      AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
    .bind(
      candidate.text,
      DateTime.formatIso(candidate.updatedAt),
      subject.userId,
      candidate.id,
      ...authority.bindings
    );
};

export const deleteMemory = ({
  db,
  subject,
  id,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: string;
  current: number;
}>): D1PreparedStatement => {
  const authority = callerAuthority({ subject, current });
  return db
    .prepare(`DELETE FROM memories WHERE user_id = ? AND id = ?
      AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
    .bind(subject.userId, id, ...authority.bindings);
};

/** The Memory owner's exact trigger metric, asserted for a named child before its write. */
export const memoryCapacityGuards =
  (candidate: Memory) =>
  ({
    db,
    userId,
    index,
    operation,
  }: Readonly<{
    db: D1Database;
    userId: string;
    index: number;
    operation: string;
  }>): ReadonlyArray<D1PreparedStatement> => [
    db
      .prepare(`INSERT INTO canonical_child_guard (child_index,operation,accepted,capacity_ok)
      SELECT ?,?,1,CASE WHEN
        (SELECT COALESCE(SUM(length(CAST(json_object('id', id, 'text', text) AS BLOB))), 0)
          FROM memories WHERE user_id = ? AND id <> ?)
        + length(CAST(json_object('id', ?, 'text', ?) AS BLOB))
        + (SELECT count(*) FROM memories WHERE user_id = ? AND id <> ?) <= ?
        THEN 1 ELSE 0 END
      ON CONFLICT(child_index) DO UPDATE SET operation = excluded.operation,
        accepted = excluded.accepted, capacity_ok = excluded.capacity_ok`)
      .bind(
        index,
        operation,
        userId,
        candidate.id,
        candidate.id,
        candidate.text,
        userId,
        candidate.id,
        maximumAggregateMemoryTokens
      ),
  ];

/** Decode the entire current aggregate under the exact subject-correlated live authority. */
export const readCurrentMemories = ({
  db,
  userId,
  authority,
}: Readonly<{
  db: D1Database;
  userId: string;
  authority: OwnedStatement;
}>): Effect.Effect<Option.Option<ReadonlyArray<Memory>>> => {
  const query = memoryRowsQuery({ userId, authority });
  return Effect.tryPromise(() =>
    db
      .prepare(query.sql)
      .bind(...query.params)
      .all()
  ).pipe(
    Effect.map((rows) => memoriesFromRows(rows.results)),
    Effect.orElseSucceed(() => Option.none())
  );
};
