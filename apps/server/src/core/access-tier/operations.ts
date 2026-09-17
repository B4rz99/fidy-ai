import { Effect } from "effect";
import type { AccessTier } from "./contract";

/** Derives the User's current capability tier from active trial and paid Pro facts. */
export const decideAccessTier = Effect.fn("decideAccessTier")(function* (input: {
  readonly trialActive: boolean;
  readonly paidProActive: boolean;
}) {
  return yield* Effect.succeed<AccessTier>(
    input.trialActive || input.paidProActive ? "pro" : "free"
  );
});
