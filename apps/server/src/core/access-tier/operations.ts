import { Effect } from "effect";
import type { AccessTier } from "./contract";

type AccessTierBasis = Readonly<{ trialActive: boolean; paidProActive: boolean }>;

/** Derives the User's current capability tier from active trial and paid Pro facts. */
export const deriveAccessTier = (input: AccessTierBasis): AccessTier =>
  input.trialActive || input.paidProActive ? "pro" : "free";

/** Effectful AccessTier decision from the same current trial and paid-period activity facts. */
export const decideAccessTier = Effect.fn("decideAccessTier")((input: AccessTierBasis) =>
  Effect.succeed(deriveAccessTier(input))
);
