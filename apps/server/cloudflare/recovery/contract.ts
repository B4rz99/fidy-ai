import { Data } from "effect";

export class RecoveryRetentionUnavailable extends Data.TaggedError(
  "RecoveryRetentionUnavailable"
) {}

export type SupportAccessConfiguration = Readonly<{
  CLOUDFLARE_ACCESS_ISSUER: string;
  CLOUDFLARE_ACCESS_AUDIENCE: string;
}>;

export const supportRecoveryPath = "/internal/support-recovery";
