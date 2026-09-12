import { type Config, type Redacted, Schema } from "effect";
import type { WompiEnvironment } from "~/core/subscription/model";
import { configuredSecret } from "~/shell/_shared/configured-secret";

/** Public prefixes shared by every Wompi credential for one environment. */
export type WompiCredentialPrefixes = Readonly<{
  readonly publicKey: string;
  readonly privateKey: string;
  readonly integritySecret: string;
  readonly eventSecret: string;
}>;

const prefixesByEnvironment = {
  sandbox: {
    publicKey: "pub_test_",
    privateKey: "prv_test_",
    integritySecret: "test_integrity_",
    eventSecret: "test_events_",
  },
  production: {
    publicKey: "pub_prod_",
    privateKey: "prv_prod_",
    integritySecret: "prod_integrity_",
    eventSecret: "prod_events_",
  },
} as const satisfies Readonly<Record<WompiEnvironment, WompiCredentialPrefixes>>;

/**
 * One environment → credential-prefix table so enrollment, billing, and settlement all gate their
 * credentials against the same authority. The prefixes are public, not Secrets: they exist to catch
 * a key issued for the other environment before any provider request is signed.
 */
export const wompiCredentialPrefixes = (environment: WompiEnvironment): WompiCredentialPrefixes =>
  prefixesByEnvironment[environment];

const PrivateKey = Schema.String.check(Schema.isPattern(/^prv_(?:test|prod)_[A-Za-z0-9_-]{8,}$/u));

/**
 * Reads `WOMPI_PRIVATE_KEY` and proves it against `environment` while it stays wrapped. Enrollment
 * and billing share this one gate so the two adapters cannot drift on the environment prefix.
 */
export const wompiPrivateKey = (
  environment: WompiEnvironment
): Config.Config<Redacted.Redacted<string>> =>
  configuredSecret({
    name: "WOMPI_PRIVATE_KEY",
    schema: PrivateKey.check(Schema.isStartsWith(wompiCredentialPrefixes(environment).privateKey)),
    requirement: `must be a ${environment} Wompi private key`,
  });
