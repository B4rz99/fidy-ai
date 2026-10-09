import { Data, type Option } from "effect";
import type { AuthenticationProvider } from "../../../src/shell/provider-authentication/contract";
import type { ProviderEnvironment } from "../contract";

/** Private, finite rejection evidence; never retains a provider cause or protocol value. */
export class ProviderVerificationFailure extends Data.TaggedError("ProviderVerificationFailure")<{
  readonly reason:
    | "configuration_invalid"
    | "token_transport_failed"
    | "token_refused"
    | "token_invalid_client"
    | "token_invalid_grant"
    | "token_response_invalid"
    | "signing_keys_failed"
    | "signature_invalid"
    | "token_expired"
    | "audience_mismatch"
    | "issuer_mismatch"
    | "signing_key_unmatched"
    | "token_verification_failed"
    | "claims_invalid"
    | "nonce_mismatch"
    | "issued_in_future"
    | "authorized_party_mismatch";
}> {}

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
