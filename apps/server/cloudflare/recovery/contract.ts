import type { UserId } from "../../src/core/identity/contract";
import { Data } from "effect";

/** Recovery evidence cleanup is unavailable; no storage error or claimant proof escapes. */
export class RecoveryRetentionUnavailable extends Data.TaggedError(
  "RecoveryRetentionUnavailable"
) {}

/** Incoming fresh-session request; the owner decodes and rechecks authority before rotation. */
export type RecoveryRequest = Readonly<{ request: Request; db: D1Database }>;

/** Dedicated Access application whose origin-verified assertion identifies the support operator. */
export type SupportAccessConfiguration = Readonly<{
  CLOUDFLARE_ACCESS_ISSUER: string;
  CLOUDFLARE_ACCESS_AUDIENCE: string;
}>;

/** Support receives a public pairing reference and emergency proof, never browser-session authority. */
export type SupportRecoveryRequest = RecoveryRequest &
  Readonly<{ config: SupportAccessConfiguration }>;

/**
 * Verified enrollment owns the atomic unit. Commit the supplied credential insertion in the same
 * D1 batch as this exact User's creation, mailbox, Consent and final current-proof assertion.
 * Resolve only after that complete batch commits; rejection prevents one-time disclosure.
 */
export type InitialRecoveryEnrollment = Readonly<{
  db: D1Database;
  userId: UserId;
  createdAtMs: number;
  commit: (credential: D1PreparedStatement) => Promise<void>;
}>;

/** Private operator transport; never part of the browser or canonical API. */
export const supportRecoveryPath = "/internal/support-recovery";
