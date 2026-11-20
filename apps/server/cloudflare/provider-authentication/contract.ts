import type { PendingConsentExchangeId } from "../../src/shell/consent/contract";
import { Data } from "effect";
import type { UserId } from "../../src/core/identity/contract";
import type { DisclosureSnapshot } from "../../src/core/consent/contract";

export type ProviderConfiguration = Readonly<{ BROWSER_ORIGIN: string }> &
  Partial<
    Readonly<{
      GOOGLE_CLIENT_ID: string;
      GOOGLE_CLIENT_SECRET: string;
      GOOGLE_REDIRECT_URI: string;
      MICROSOFT_CLIENT_ID: string;
      MICROSOFT_CLIENT_SECRET: string;
      MICROSOFT_REDIRECT_URI: string;
    }>
  >;

export type ProviderEnvironment = ProviderConfiguration & Readonly<{ DB: D1Database }>;

export type ProvenProviderSignup = Readonly<{
  origin:
    | Readonly<{ _tag: "Web" }>
    | Readonly<{ _tag: "WhatsApp"; exchangeId: PendingConsentExchangeId }>;
  attemptId: string;
  disclosure: DisclosureSnapshot;
  acceptedAtMs: number;
  verifiedAtMs: number;
  commit: (
    input: Readonly<{ userId: UserId; statements: ReadonlyArray<D1PreparedStatement> }>
  ) => Promise<void>;
}>;
export type ProviderCompletionRequest = Readonly<{
  request: Request;
  db: D1Database;
  complete: (proof: ProvenProviderSignup) => Promise<Response>;
}>;

export class ProviderAuthenticationRetentionUnavailable extends Data.TaggedError(
  "ProviderAuthenticationRetentionUnavailable"
) {}
