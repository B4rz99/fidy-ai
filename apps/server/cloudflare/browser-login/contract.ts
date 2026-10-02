import type { OwnedStatement } from "../../src/shell/_shared/owned-statement";

/** Origin-qualified WhatsApp decision, authenticated by the channel before pairing approval. */
export type BrowserPairingApproval = Readonly<{
  db: D1Database;
  input: Readonly<{
    portfolioId: string;
    bsuid: string;
    messageId: string;
    publicCode: string;
    occurredAtMs: number;
    receivedAtMs: number;
  }>;
}>;

/** The exact browser-private proof presented for a single pairing at this decision instant. */
export type BrowserPairingProof = Readonly<{
  pairingId: string;
  verifierDigest: Uint8Array;
  current: number;
}>;

/**
 * BrowserLogin-owned one-use consumption and stable User projection, composed in one D1 batch.
 * The subject exposes only pairingId and userId after this exact proof's successful consumption.
 */
export type BrowserPairingClaim = Readonly<{
  consume: OwnedStatement;
  subject: OwnedStatement;
  current: number;
}>;

/** Exact browser-held private verifier required before starting or completing mailbox approval. */
export type PendingBrowserPairingRequest = Readonly<{
  db: D1Database;
  pairingId: string;
  privateVerifier: string;
}>;
/** Trusted subject SQL projects exactly one pairingId; the owner enforces its current pending lifetime. */
export type PendingBrowserPairingQuery = Readonly<{ subject: OwnedStatement; current: number }>;
/** Owner-verified channel evidence projects userId; approval and proof consumption share the caller's D1 batch. */
export type BrowserPairingApprovalStatement = Readonly<{
  db: D1Database;
  pairingId: string;
  subject: OwnedStatement;
  current: number;
}>;
