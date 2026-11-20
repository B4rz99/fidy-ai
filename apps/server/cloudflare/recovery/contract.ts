import type { UserId } from "../../src/core/identity/contract";
import { Data } from "effect";

export class RecoveryRetentionUnavailable extends Data.TaggedError(
  "RecoveryRetentionUnavailable"
) {}

export type RecoveryRequest = Readonly<{ request: Request; db: D1Database }>;

export type SupportAccessConfiguration = Readonly<{
  CLOUDFLARE_ACCESS_ISSUER: string;
  CLOUDFLARE_ACCESS_AUDIENCE: string;
}>;

export type SupportRecoveryRequest = RecoveryRequest &
  Readonly<{ config: SupportAccessConfiguration }>;

export type InitialRecoveryEnrollment = Readonly<{
  db: D1Database;
  userId: UserId;
  createdAtMs: number;
  commit: (credential: D1PreparedStatement) => Promise<void>;
}>;

export const supportRecoveryPath = "/internal/support-recovery";
