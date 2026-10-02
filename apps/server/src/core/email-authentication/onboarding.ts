/** A fourth wrong proof closes the pending enrollment; later attempts cannot revive it. */
export const maximumOnboardingProofFailures = 4;

/** A proof is redeemable only during both its own lifetime and the pending enrollment's lifetime. */
export const canRedeemOnboardingProof = (
  input: Readonly<{
    state: "awaiting_proof" | "awaiting_delivery" | "sending" | "rejected" | "ambiguous";
    expiresAtMs: number;
    proofExpiresAtMs: number;
    nowMs: number;
  }>
): boolean =>
  input.state === "awaiting_proof" &&
  input.expiresAtMs > input.nowMs &&
  input.proofExpiresAtMs > input.nowMs;
