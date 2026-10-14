import { Effect } from "effect";
import { type Memory, MemoryCapacityExceeded, maximumAggregateMemoryTokens } from "./contract";

export const admitMemory = (decision: {
  readonly candidate: Memory;
  readonly aggregateTokens: number;
}): Effect.Effect<Memory, MemoryCapacityExceeded> =>
  decision.aggregateTokens > maximumAggregateMemoryTokens
    ? Effect.fail(new MemoryCapacityExceeded())
    : Effect.succeed(decision.candidate);
