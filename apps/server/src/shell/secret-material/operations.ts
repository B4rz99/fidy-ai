import { type Config, Crypto, Effect, Encoding, type Redacted, Schema } from "effect";
import type { WompiEnvironment } from "~/core/subscription/model";
import type { TokenBearer } from "~/core/tokens/model";
import { configuredSecret } from "~/shell/secret-material/internal/configured-secret";

/** A lowercase SHA-256 digest used only for PAT persistence and lookup. */
export const PATBearerDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand("PATBearerDigest")
);
export type PATBearerDigest = typeof PATBearerDigest.Type;

/** Public prefixes used to reject Wompi credentials issued for the wrong environment. */
export type WompiCredentialPrefixes = Readonly<{
  readonly publicKey: string;
  readonly privateKey: string;
  readonly integritySecret: string;
}>;

const wompiPrefixesByEnvironment = {
  sandbox: {
    publicKey: "pub_test_",
    privateKey: "prv_test_",
    integritySecret: "test_integrity_",
  },
  production: {
    publicKey: "pub_prod_",
    privateKey: "prv_prod_",
    integritySecret: "prod_integrity_",
  },
} as const satisfies Readonly<Record<WompiEnvironment, WompiCredentialPrefixes>>;

/** Returns the public credential prefixes for one Wompi environment. */
export const wompiCredentialPrefixes = (environment: WompiEnvironment): WompiCredentialPrefixes =>
  wompiPrefixesByEnvironment[environment];

const resendApiKey = (): Config.Config<Redacted.Redacted<string>> =>
  configuredSecret({
    name: "RESEND_API_KEY",
    schema: Schema.String.check(Schema.isPattern(/^re_[A-Za-z0-9_-]{20,253}$/u)),
    requirement: "must be a Resend API key",
  });

/** Resolves the redacted API key used to submit verification email through Resend. */
export const loadResendEmailDeliveryApiKey = resendApiKey();

const WompiPrivateKey = Schema.String.check(
  Schema.isPattern(/^prv_(?:test|prod)_[A-Za-z0-9_-]{8,}$/u)
);
const WompiIntegritySecret = Schema.String.check(
  Schema.isPattern(/^test_integrity_[A-Za-z0-9_-]{8,}$|^prod_integrity_[A-Za-z0-9_-]{8,}$/u)
);
/** Resolves the redacted private key used for Wompi enrollment and billing requests. */
export const loadWompiPrivateKey = (
  environment: WompiEnvironment
): Config.Config<Redacted.Redacted<string>> =>
  configuredSecret({
    name: "WOMPI_PRIVATE_KEY",
    schema: WompiPrivateKey.check(
      Schema.isStartsWith(wompiCredentialPrefixes(environment).privateKey)
    ),
    requirement: `must be a ${environment} Wompi private key`,
  });

/** Resolves the redacted secret used to sign Wompi transaction integrity material. */
export const loadWompiIntegritySecret = (
  environment: WompiEnvironment
): Config.Config<Redacted.Redacted<string>> =>
  configuredSecret({
    name: "WOMPI_INTEGRITY_SECRET",
    schema: WompiIntegritySecret.check(
      Schema.isStartsWith(wompiCredentialPrefixes(environment).integritySecret)
    ),
    requirement: `must be a ${environment} Wompi integrity secret`,
  });

/** Derives the one-way SHA-256 digest persisted and compared when authenticating a PAT bearer. */
export const derivePATBearerDigest = (
  bearer: TokenBearer
): Effect.Effect<PATBearerDigest, never, Crypto.Crypto> =>
  Effect.flatMap(Crypto.Crypto, (crypto) =>
    crypto.digest("SHA-256", new TextEncoder().encode(bearer))
  ).pipe(
    Effect.map((digest) => PATBearerDigest.make(Encoding.encodeHex(digest))),
    Effect.orDie
  );
