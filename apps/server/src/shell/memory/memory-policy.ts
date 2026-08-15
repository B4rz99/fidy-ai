import { DateTime, Effect, Schema, Struct } from "effect";
import { Memory } from "~/core/memory/model";
import { admitMemory } from "~/core/memory/rules";
import { HostedInference } from "~/shell/agent/hosted-inference";

const MemoryProjection = Memory.mapFields(Struct.pick(["id", "text"]));
const encodeMemoryProjection = Schema.encodeSync(Schema.fromJsonString(MemoryProjection));

/** Encodes recall-ordered `{id,text}` projections as one compact JSON object per LF-delimited line. */
export const projectMemoryAggregate = (memories: ReadonlyArray<Memory>): string =>
  memories.map((memory) => encodeMemoryProjection(memory)).join("\n");

const compareRecallOrder = (left: Memory, right: Memory): number => {
  const instant = DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt);
  if (instant !== 0) return instant;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
};

const countAndAdmitFinalAggregate = Effect.fn("countAndAdmitFinalAggregate")(function* (
  final: ReadonlyArray<Memory>,
  candidate: Memory
) {
  const inference = yield* HostedInference;
  const finalRecallOrder = [...final].sort(compareRecallOrder);
  const tokens = yield* inference.countText(projectMemoryAggregate(finalRecallOrder));
  return yield* admitMemory({ candidate, aggregateTokens: tokens });
});

/** Counts the complete stable aggregate locally before admitting one new Memory. */
export const countAndAdmitMemory = Effect.fn("countAndAdmitMemory")(function* (
  current: ReadonlyArray<Memory>,
  candidate: Memory
) {
  return yield* countAndAdmitFinalAggregate([...current, candidate], candidate);
});

/** Counts a complete aggregate with one current Memory replaced in place. */
export const countAndAdmitMemoryRevision = Effect.fn("countAndAdmitMemoryRevision")(function* (
  current: ReadonlyArray<Memory>,
  candidate: Memory
) {
  const final = current.map((memory) => (memory.id === candidate.id ? candidate : memory));
  return yield* countAndAdmitFinalAggregate(final, candidate);
});
