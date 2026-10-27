import { Data } from "effect";

export class BancolombiaAuthenticationFailed extends Data.TaggedError(
  "BancolombiaAuthenticationFailed"
)<{
  readonly stage:
    | "bancolombia_configuration"
    | "bancolombia_signing"
    | "bancolombia_discovery"
    | "bancolombia_authentication";
}> {}

/** Private Core-only application authentication; transport and signing keys have separate custody. */
export type BancolombiaSandboxEnvironment = Partial<
  Readonly<{
    BANCOLOMBIA_SANDBOX_CLIENT_ID: string;
    BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM: string;
    BANCOLOMBIA_SANDBOX_MTLS: Pick<Fetcher, "fetch">;
  }>
>;
