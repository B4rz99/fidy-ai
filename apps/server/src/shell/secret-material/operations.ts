import { type Config, Crypto, Effect, Encoding, type Redacted, Schema } from "effect";
import type { EmailAddress } from "~/core/email-authentication/model";
import type { WompiEnvironment } from "~/core/subscription/model";
import type { TokenBearer } from "~/core/tokens/model";
import { configuredSecret } from "~/shell/secret-material/internal/configured-secret";
import { configuredHmacKey, hmacSha256 } from "~/shell/secret-material/internal/keyed-digest";

/** A lowercase SHA-256 digest used only for PAT persistence and lookup. */
export const PATBearerDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand("PATBearerDigest")
);
export type PATBearerDigest = typeof PATBearerDigest.Type;

/**
 * One anonymous admission purpose. Each purpose is a separate namespace, so identifiers derived
 * for different admission paths cannot be correlated.
 */
export type AnonymousSourcePurpose =
  | "browser-login-start"
  | "pat-pairing-start"
  | "pat-pairing-claim";

/** Public prefixes used to reject Wompi credentials issued for the wrong environment. */
export type WompiCredentialPrefixes = Readonly<{
  readonly publicKey: string;
  readonly privateKey: string;
  readonly integritySecret: string;
  readonly eventSecret: string;
}>;

const wompiPrefixesByEnvironment = {
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

/** Returns the public credential prefixes for one Wompi environment. */
export const wompiCredentialPrefixes = (environment: WompiEnvironment): WompiCredentialPrefixes =>
  wompiPrefixesByEnvironment[environment];

/** Resolves the redacted credential used to authenticate Cluster transport. */
export const loadClusterAuthenticationToken = configuredSecret({
  name: "FIDY_CLUSTER_AUTH_TOKEN",
  schema: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  requirement: "must be a 32-byte lowercase hexadecimal key",
});

const resendApiKey = (): Config.Config<Redacted.Redacted<string>> =>
  configuredSecret({
    name: "RESEND_API_KEY",
    schema: Schema.String.check(Schema.isPattern(/^re_[A-Za-z0-9_-]{20,253}$/u)),
    requirement: "must be a Resend API key",
  });

/** Resolves the redacted API key used to submit verification email through Resend. */
export const loadResendEmailDeliveryApiKey = resendApiKey();

/** Resolves the redacted API key used to retrieve received email from Resend. */
export const loadResendReceivingApiKey = resendApiKey();

const WompiPrivateKey = Schema.String.check(
  Schema.isPattern(/^prv_(?:test|prod)_[A-Za-z0-9_-]{8,}$/u)
);
const WompiIntegritySecret = Schema.String.check(
  Schema.isPattern(/^test_integrity_[A-Za-z0-9_-]{8,}$|^prod_integrity_[A-Za-z0-9_-]{8,}$/u)
);
const WompiEventSecret = Schema.String.check(
  Schema.isPattern(/^test_events_[A-Za-z0-9_-]{8,}$|^prod_events_[A-Za-z0-9_-]{8,}$/u)
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

/** Resolves the redacted secret used to authenticate Wompi settlement events. */
export const loadWompiEventSecret = (
  environment: WompiEnvironment
): Config.Config<Redacted.Redacted<string>> =>
  configuredSecret({
    name: "WOMPI_EVENT_SECRET",
    schema: WompiEventSecret.check(
      Schema.isStartsWith(wompiCredentialPrefixes(environment).eventSecret)
    ),
    requirement: `must be a ${environment} Wompi event secret`,
  });

/**
 * Derives the keyed identifier retained as anonymous source admission evidence. It is suitable only
 * for abuse admission, never identity or authorization. Invalid production configuration fails
 * without exposing the key or source address.
 */
export const deriveAnonymousSourceIdentifier = Effect.fn(function* (
  purpose: AnonymousSourcePurpose,
  sourceAddress: string
) {
  const secret = yield* configuredHmacKey({
    variable: "SOURCE_ADMISSION_HMAC_KEY",
    developmentFallback: "local-source-admission-key-not-for-production",
  });
  return hmacSha256({ secret, payload: `${purpose}\u0000${sourceAddress}` });
});

/**
 * Derives the stable one-way lookup key for a normalized VerifiedEmailCredential address. The
 * configured key remains private and malformed production configuration fails without disclosing
 * either value.
 */
export const deriveEmailCredentialLookupKey = Effect.fn(function* (email: EmailAddress) {
  const secret = yield* configuredHmacKey({
    variable: "EMAIL_CREDENTIAL_LOOKUP_HMAC_KEY",
    developmentFallback: "local-email-credential-lookup-key-not-for-production",
  });
  return hmacSha256({ secret, payload: `verified-email-credential:${email}` }).toString("hex");
});

/**
 * Derives a non-reversible key for one email-authentication admission scope. Callers construct only
 * scopes owned by an admission policy; the configured HMAC key never crosses this interface.
 */
export const deriveEmailAuthenticationAdmissionKey = Effect.fn(function* (scope: string) {
  const secret = yield* configuredHmacKey({
    variable: "EMAIL_ADMISSION_HMAC_KEY",
    developmentFallback: "local-email-admission-key-not-for-production",
  });
  return hmacSha256({ secret, payload: scope }).toString("hex");
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
