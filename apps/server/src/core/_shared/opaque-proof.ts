/** Encoded length of a 32-octet unpadded base64url proof. */
export const opaqueProof32EncodedLength = 43;

const opaqueProof32Pattern = /^[A-Za-z0-9_-]{43}$/u;

/**
 * Maps any already-bounded wire string to fixed-cost digest input without accepting it as a valid
 * proof. Callers still decide validity from the associated typed identifier or digest comparison.
 */
export const normalizeOpaqueProof32 = (input: string): string =>
  opaqueProof32Pattern.test(input)
    ? input
    : input.slice(0, opaqueProof32EncodedLength).padEnd(opaqueProof32EncodedLength, ".");
