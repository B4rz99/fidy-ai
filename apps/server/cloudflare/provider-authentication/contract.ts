import { Data } from "effect";
import type { UserId } from "../../src/core/identity/contract";
import type { DisclosureSnapshot } from "../../src/core/consent/contract";
/** Operator-owned provider application configuration; absent configuration disables authentication. */
export type ProviderEnvironment = Readonly<{ DB: D1Database; BROWSER_ORIGIN: string }> &
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

/** One-use verified web origin. Compose owner records only inside this request and commit them together. */
export type ProvenProviderSignup = Readonly<{
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

/** Closed Maintenance failure; no protocol state or provider cause is exported. */
export class ProviderAuthenticationRetentionUnavailable extends Data.TaggedError(
  "ProviderAuthenticationRetentionUnavailable"
) {}
