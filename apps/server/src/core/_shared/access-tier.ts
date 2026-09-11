import { Effect, Schema } from "effect";

/** Free or Pro capabilities currently granted to a User. */
export const AccessTier = Schema.Literals(["free", "pro"]).annotate({
  identifier: "AccessTier",
});
export type AccessTier = typeof AccessTier.Type;

/** Chooses the capabilities granted by current trial and paid Subscription facts. */
export const decideAccessTier = Effect.fn("decideAccessTier")(function* (input: {
  readonly trialActive: boolean;
  readonly paidProActive: boolean;
}) {
  return yield* Effect.succeed<AccessTier>(
    input.trialActive || input.paidProActive ? "pro" : "free"
  );
});
