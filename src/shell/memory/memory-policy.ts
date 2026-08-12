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

/** Counts the complete stable aggregate locally before applying Memory capacity policy. */
export const countAndAdmitMemory = Effect.fn("countAndAdmitMemory")(function* (
  current: ReadonlyArray<Memory>,
  candidate: Memory
) {
  const inference = yield* HostedInference;
  const finalRecallOrder = [...current, candidate].sort(compareRecallOrder);
  const tokens = yield* inference.countMemoryText(projectMemoryAggregate(finalRecallOrder));
  return yield* admitMemory({ candidate, aggregateTokens: tokens });
});
