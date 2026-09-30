import type { AccessTier } from "./contract";

type AccessTierBasis = Readonly<{ trialActive: boolean; paidProActive: boolean }>;

/** Derives the User's current capability tier from active trial and paid Pro facts. */
export const deriveAccessTier = (input: AccessTierBasis): AccessTier =>
  input.trialActive || input.paidProActive ? "pro" : "free";
