import { ConnectionConsentIntent } from "../connections/contract";
import { UserId } from "../../src/core/identity/contract";
import { Data, Schema } from "effect";

export class BancolombiaAuthenticationFailed extends Data.TaggedError(
  "BancolombiaAuthenticationFailed"
)<{
  readonly stage:
    | "bancolombia_configuration"
    | "bancolombia_signing"
    | "bancolombia_discovery"
    | "bancolombia_authentication";
}> {}

export class BancolombiaAuthorizationFailed extends Data.TaggedError(
  "BancolombiaAuthorizationFailed"
) {}

/** Private Core-only application authentication; transport and signing keys have separate custody. */
export type BancolombiaSandboxEnvironment = Partial<
  Readonly<{
    BANCOLOMBIA_SANDBOX_CLIENT_ID: string;
    BANCOLOMBIA_SANDBOX_CONSENT_PROFILE: string;
    BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM: string;
    BANCOLOMBIA_SANDBOX_MTLS: Pick<Fetcher, "fetch">;
  }>
>;

const maximumConsentLength = 128;
export const BancolombiaAuthorizationInput = Schema.Struct({
  consentId: Schema.String.check(
    Schema.isBetweenLength(1, maximumConsentLength),
    Schema.isPattern(/^[A-Za-z0-9_-]+$/u)
  ),
  state: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  nonce: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  challenge: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  expiresAtMilliseconds: Schema.Int,
});
export type BancolombiaAuthorizationInput = typeof BancolombiaAuthorizationInput.Type;

export const BancolombiaConsentProfile = Schema.Struct({
  contract: Schema.Literal("b794218bd9dbf50f68b20aa2335e552ecfb5734830a9fc1c36e70622b5928650"),
  userId: UserId,
  financialId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u)),
  accountOwner: Schema.Struct({
    SchemeName: Schema.Literals(["CC", "NIT", "CE", "TI", "PA", "CD", "PPT", "RC"]),
    Identification: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,35}$/u)),
  }),
  intent: ConnectionConsentIntent,
});
export type BancolombiaConsentProfile = typeof BancolombiaConsentProfile.Type;
