import { maximumAggregateMemoryTokens } from "@fidy/server/memory-operations";
import { DateTime, Option, Schema } from "effect";
import { Memory, MemoryId, MemoryText } from "@fidy/server/memory-contract";
import type { OwnedStatement } from "../../../src/shell/_shared/owned-statement";
import type { MemoryAuthority } from "../contract";

/** The exact Memory row projection every owner query returns, kept in one place. */
const memoryRowColumns = "id,text,created_at,updated_at";

/**
 * Every current Memory of one explicit User in stable ascending creation and identity order —
 * exactly the order the aggregate capacity is counted in. The projection is guarded by the live
 * credential so a revoked or withdrawn authority cannot read.
 */
export const memoryRowsQuery = ({
  userId,
  authority,
}: Readonly<{ userId: string; authority: MemoryAuthority }>): OwnedStatement => ({
  sql: `SELECT ${memoryRowColumns} FROM memories
    WHERE user_id = ? AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
    ORDER BY created_at, id`,
  params: [userId, ...authority.bindings],
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

/** Insert a candidate under the User selected by live caller authority. */
export const insertMemory = ({
  db,
  authority,
  candidate,
}: Readonly<{
  db: D1Database;
  authority: MemoryAuthority;
  candidate: Memory;
}>): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO memories (id, user_id, text, created_at, updated_at)
      SELECT ?, user_id, ?, ?, ? FROM ${authority.table} WHERE ${authority.predicate}`)
    .bind(
      candidate.id,
      candidate.text,
      DateTime.formatIso(candidate.createdAt),
      DateTime.formatIso(candidate.updatedAt),
      ...authority.bindings
    );

export const replaceMemory = ({
  db,
  userId,
  authority,
  candidate,
}: Readonly<{
  db: D1Database;
  userId: string;
  authority: MemoryAuthority;
  candidate: Memory;
}>): D1PreparedStatement =>
  db
    .prepare(`UPDATE memories SET text = ?, updated_at = ? WHERE user_id = ? AND id = ?
      AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
    .bind(
      candidate.text,
      DateTime.formatIso(candidate.updatedAt),
      userId,
      candidate.id,
      ...authority.bindings
    );

export const deleteMemory = ({
  db,
  userId,
  authority,
  id,
}: Readonly<{
  db: D1Database;
  userId: string;
  authority: MemoryAuthority;
  id: string;
}>): D1PreparedStatement =>
  db
    .prepare(`DELETE FROM memories WHERE user_id = ? AND id = ?
      AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
    .bind(userId, id, ...authority.bindings);

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
