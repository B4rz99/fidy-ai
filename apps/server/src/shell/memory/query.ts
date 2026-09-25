import { Option, Schema } from "effect";
import { Memory, MemoryId, MemoryText } from "~/core/memory/model";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import type { WebSessionAuthority } from "~/shell/identity/session-guard";
import type { PATAuthority } from "~/shell/tokens/pat-write";

/** Live credential re-evaluated by D1 beside this owner-published Memory projection. */
type MemoryAuthority = PATAuthority | WebSessionAuthority;

/**
 * Every current Memory of one explicit User in stable ascending creation and identity order —
 * exactly the order the aggregate capacity is counted in. The projection is guarded by the live
 * credential so a revoked or withdrawn authority cannot read.
 */
export const memoryRowsQuery = ({
  userId,
  authority,
}: Readonly<{ userId: string; authority: MemoryAuthority }>): OwnedStatement => ({
  sql: `SELECT id,text,created_at,updated_at FROM memories
    WHERE user_id = ? AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
    ORDER BY created_at, id`,
  params: [userId, ...authority.bindings],
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
