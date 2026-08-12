import { Data, Effect } from "effect";
import type { Memory } from "./model";

/** Inclusive token capacity for the complete recall-ordered Memory aggregate. */
export const maximumAggregateMemoryTokens = 15_000;

/** Fixed content-free policy failure; Memory prose and identity never enter the error. */
export class MemoryCapacityExceeded extends Data.TaggedError("MemoryCapacityExceeded")<{}> {
  override get message(): string {
    return "The User's current Memories have reached their aggregate token capacity";
  }
}

/** Applies the server-owned aggregate capacity decision to an already-counted candidate. */
export const admitMemory = (decision: {
  readonly candidate: Memory;
  readonly aggregateTokens: number;
}): Effect.Effect<Memory, MemoryCapacityExceeded> =>
  decision.aggregateTokens > maximumAggregateMemoryTokens
    ? Effect.fail(new MemoryCapacityExceeded())
    : Effect.succeed(decision.candidate);
