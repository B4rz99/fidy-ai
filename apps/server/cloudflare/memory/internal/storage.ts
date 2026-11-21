import { Option, Schema } from "effect";
import { Memory, MemoryId, MemoryText } from "../../../src/core/memory/contract";

const MemoryRow = Schema.Struct({
  id: MemoryId,
  text: MemoryText,
  created_at_ms: Schema.DateTimeUtcFromMillis,
  updated_at_ms: Schema.DateTimeUtcFromMillis,
});

export const memoriesFromRows = (rows: unknown): Option.Option<ReadonlyArray<Memory>> => {
  const decoded = Schema.decodeUnknownOption(Schema.Array(MemoryRow))(rows);

  return Option.flatMap(decoded, (values) => {
    const memories: Array<Memory> = [];

    for (const row of values) {
      const memory = Schema.decodeOption(Schema.toType(Memory))({
        id: row.id,
        text: row.text,
        createdAt: row.created_at_ms,
        updatedAt: row.updated_at_ms,
      });

      if (Option.isNone(memory)) return Option.none<ReadonlyArray<Memory>>();
      memories.push(memory.value);
    }

    return Option.some(memories);
  });
};
