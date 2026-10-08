import type { Option } from "effect";
import type { AuthenticationProvider } from "../../../src/shell/provider-authentication/contract";
import type { ProviderEnvironment } from "../contract";

export type Validation = Readonly<{
  environment: ProviderEnvironment;
  provider: AuthenticationProvider;
  query: URLSearchParams;
  verifier: string;
  attempt: Readonly<{ id: string; nonce: string; expires_at_ms: number }>;
}>;
export type VerifiedProviderIdentity = Readonly<{
  issuer: string;
  subject: string;
  contactEmail: Option.Option<string>;
  expiresAtMs: number;
}>;
