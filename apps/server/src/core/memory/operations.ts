import { Effect } from "effect";
import { type Memory, MemoryCapacityExceeded } from "./contract";

/** Inclusive token capacity for the complete recall-ordered Memory aggregate. */
export const maximumAggregateMemoryTokens = 15_000;

/** Applies the server-owned aggregate capacity decision to an already-counted candidate. */
export const admitMemory = (decision: {
  readonly candidate: Memory;
  readonly aggregateTokens: number;
}): Effect.Effect<Memory, MemoryCapacityExceeded> =>
  decision.aggregateTokens > maximumAggregateMemoryTokens
    ? Effect.fail(new MemoryCapacityExceeded())
    : Effect.succeed(decision.candidate);
