import { createHash, createHmac } from "node:crypto";
import { BunCrypto } from "@effect/platform-bun";
import { expect, it, layer } from "@effect/vitest";
import assert from "node:assert/strict";
import { Cause, Config, ConfigProvider, Effect, Encoding, Exit, Redacted } from "effect";
import { EmailAddress } from "~/core/email-authentication/model";
import {
  type AnonymousSourcePurpose,
  deriveAnonymousSourceIdentifier,
  deriveEmailAuthenticationAdmissionKey,
  deriveEmailCredentialLookupKey,
  derivePATBearerDigest,
  loadClusterAuthenticationToken,
} from "./operations";
import { TokenBearer } from "~/core/tokens/model";
import { expectNotInspected } from "~/shell/testing/credential-failure";

const productionKey = "ab".repeat(32);
const clusterToken = "f1".repeat(32);
const rotatedKey = "cd".repeat(32);
const address = "203.0.113.9";

const deriveIdentifier = (
  purpose: AnonymousSourcePurpose,
  sourceAddress: string,
  environment: Readonly<Record<string, string>>
): Effect.Effect<string, Config.ConfigError> =>
  deriveAnonymousSourceIdentifier(purpose, sourceAddress).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
    Effect.map(Encoding.encodeHex)
  );

// A configured key is lowercase hexadecimal for exactly 32 key bytes; the expected identifier
// must HMAC with those decoded bytes, never the 64-character text.
const expectedIdentifierHex = (key: string, purpose: string, sourceAddress: string): string =>
  Encoding.encodeHex(
    createHmac("sha256", Buffer.from(key, "hex"))
      .update(`${purpose}\u0000${sourceAddress}`)
      .digest()
  );

const plainSha256Hex = (sourceAddress: string): string =>
  Encoding.encodeHex(createHash("sha256").update(sourceAddress).digest());

const clusterTokenWith = (
  configuration: Readonly<Record<string, string>>
): Effect.Effect<Redacted.Redacted<string>, Config.ConfigError> =>
  loadClusterAuthenticationToken.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(configuration))
  );

it.effect("keeps a valid Cluster authentication token redacted", () =>
  Effect.gen(function* () {
    const token = yield* clusterTokenWith({ FIDY_CLUSTER_AUTH_TOKEN: clusterToken });

    expect(Redacted.value(token)).toBe(clusterToken);
    expectNotInspected(token, clusterToken);
  })
);

it.effect("rejects invalid Cluster authentication tokens without exposing their values", () =>
  Effect.gen(function* () {
    for (const candidate of [undefined, `CANARY-cluster-${"f1d7c0de".repeat(3)}`]) {
      const outcome = yield* Effect.exit(
        clusterTokenWith(candidate === undefined ? {} : { FIDY_CLUSTER_AUTH_TOKEN: candidate })
      );

      expect(Exit.isFailure(outcome)).toBe(true);
      if (Exit.isFailure(outcome)) {
        const rendered = Cause.pretty(outcome.cause);
        expect(rendered).toContain("FIDY_CLUSTER_AUTH_TOKEN");
        if (candidate !== undefined) expect(rendered).not.toContain(candidate);
      }
    }
  })
);

it.effect("groups one address under a purpose and separates every other purpose", () =>
  Effect.gen(function* () {
    const environment = { NODE_ENV: "production", SOURCE_ADMISSION_HMAC_KEY: productionKey };
    const first = yield* deriveIdentifier("browser-login-start", address, environment);
    const again = yield* deriveIdentifier("browser-login-start", address, environment);
    const patStart = yield* deriveIdentifier("pat-pairing-start", address, environment);
    const patClaim = yield* deriveIdentifier("pat-pairing-claim", address, environment);
    const otherAddress = yield* deriveIdentifier(
      "browser-login-start",
      "203.0.113.10",
      environment
    );

    expect(first).toBe(expectedIdentifierHex(productionKey, "browser-login-start", address));
    expect(again).toBe(first);
    expect(new Set([first, patStart, patClaim, otherAddress]).size).toBe(4);
  })
);

it.effect("requires a validated production key and accepts the development fallback", () =>
  Effect.gen(function* () {
    const development = yield* deriveIdentifier("browser-login-start", address, {
      NODE_ENV: "development",
    });
    expect(development).toHaveLength(64);

    const absent = yield* Effect.exit(
      deriveIdentifier("browser-login-start", address, { NODE_ENV: "production" })
    );
    const empty = yield* Effect.exit(
      deriveIdentifier("browser-login-start", address, {
        NODE_ENV: "production",
        SOURCE_ADMISSION_HMAC_KEY: "",
      })
    );
    for (const outcome of [absent, empty]) {
      expect(Exit.isFailure(outcome)).toBe(true);
      if (Exit.isFailure(outcome)) {
        const rendered = Cause.pretty(outcome.cause);
        expect(rendered).toContain("SOURCE_ADMISSION_HMAC_KEY");
        expect(rendered).not.toContain(address);
      }
    }

    const malformedKeys = [
      "predictable",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
    ];
    for (const malformed of malformedKeys) {
      const outcome = yield* Effect.exit(
        deriveIdentifier("pat-pairing-start", address, {
          NODE_ENV: "production",
          SOURCE_ADMISSION_HMAC_KEY: malformed,
        })
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      if (Exit.isFailure(outcome)) {
        const rendered = Cause.pretty(outcome.cause);
        expect(rendered).toContain("SOURCE_ADMISSION_HMAC_KEY");
        expect(rendered).not.toContain(malformed);
      }
    }
  })
);

it.effect("puts the production key into every identifier and rotates cleanly", () =>
  Effect.gen(function* () {
    const before = yield* deriveIdentifier("pat-pairing-claim", address, {
      NODE_ENV: "production",
      SOURCE_ADMISSION_HMAC_KEY: productionKey,
    });
    const after = yield* deriveIdentifier("pat-pairing-claim", address, {
      NODE_ENV: "production",
      SOURCE_ADMISSION_HMAC_KEY: rotatedKey,
    });

    expect(before).toBe(expectedIdentifierHex(productionKey, "pat-pairing-claim", address));
    expect(after).toBe(expectedIdentifierHex(rotatedKey, "pat-pairing-claim", address));
    expect(before).not.toBe(after);
  })
);

it.effect("keeps the source admission HMAC key out of identifiers and failures", () =>
  Effect.gen(function* () {
    const identifier = yield* deriveIdentifier("browser-login-start", address, {
      NODE_ENV: "production",
      SOURCE_ADMISSION_HMAC_KEY: productionKey,
    });
    expect(identifier).not.toContain(productionKey);
    expect(identifier).not.toBe(plainSha256Hex(address));

    const malformed = "not-a-hex-key";
    const outcome = yield* Effect.exit(
      deriveIdentifier("pat-pairing-start", address, {
        NODE_ENV: "production",
        SOURCE_ADMISSION_HMAC_KEY: malformed,
      })
    );
    expect(Exit.isFailure(outcome)).toBe(true);
    if (Exit.isFailure(outcome)) {
      const rendered = Cause.pretty(outcome.cause);
      expect(rendered).toContain(
        "SOURCE_ADMISSION_HMAC_KEY must be a 32-byte lowercase hexadecimal key"
      );
      expect(rendered).not.toContain(malformed);
      expect(rendered).not.toContain(address);
    }
  })
);

const emailKey = "ab".repeat(32);
const emailProduction = (configuration: string, key: string): ConfigProvider.ConfigProvider =>
  ConfigProvider.fromEnv({ env: { NODE_ENV: "production", [configuration]: key } });
const lookupEmail = EmailAddress.make("lookup-key@example.com");
const admissionScope = "user:f1d1a000-0000-4000-8000-000000000101";

it.effect("derives email lookup and admission keys from the exact decoded key bytes", () =>
  Effect.gen(function* () {
    const lookup = yield* deriveEmailCredentialLookupKey(lookupEmail).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        emailProduction("EMAIL_CREDENTIAL_LOOKUP_HMAC_KEY", emailKey)
      )
    );
    expect(lookup).toBe("61dbd8c605dcea93794d0466a317794d784683802deaaeeb5e96058a7e8e5db9");
    expect(lookup).not.toBe("f666976f0cdec1fa84e35560ed07b7c6fe15550c9a6cf0f18d86fb0aa8ffd4bf");

    const admission = yield* deriveEmailAuthenticationAdmissionKey(admissionScope).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        emailProduction("EMAIL_ADMISSION_HMAC_KEY", emailKey)
      )
    );
    expect(admission).toBe("050789e53f5a91a014af4d6edd45d5efbc89b9f550899dc0cbe404e27853f44e");
  })
);

it.effect("rejects malformed email key encodings without disclosing their values", () =>
  Effect.gen(function* () {
    const malformed = [
      "malformed",
      "a".repeat(63),
      `${emailKey}00`,
      "z".repeat(64),
      "AB".repeat(32),
    ];
    for (const key of malformed) {
      const outcome = yield* deriveEmailCredentialLookupKey(lookupEmail).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          emailProduction("EMAIL_CREDENTIAL_LOOKUP_HMAC_KEY", key)
        ),
        Effect.exit
      );
      assert.deepStrictEqual(
        Exit.match(outcome, {
          onFailure: (cause) => Exit.fail(Cause.squash(cause)),
          onSuccess: Exit.succeed,
        }),
        Exit.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message:
                "EMAIL_CREDENTIAL_LOOKUP_HMAC_KEY must be a 32-byte lowercase hexadecimal key",
            })
          )
        )
      );
      if (Exit.isFailure(outcome)) {
        expect(Cause.pretty(outcome.cause)).not.toContain(key);
        expect(Cause.pretty(outcome.cause)).not.toContain(lookupEmail);
      }
    }
  })
);

it.effect("keeps the email development keys unchanged", () =>
  Effect.gen(function* () {
    expect(yield* deriveEmailCredentialLookupKey(lookupEmail)).toBe(
      "feed69ddcde5e1ee42a78840f6c0822be35ef66be69fb56fd83c0db51b3ce06b"
    );
    expect(yield* deriveEmailAuthenticationAdmissionKey(admissionScope)).toBe(
      "37c2071c7caf830f8c05b729d0a411efb0d5f6d95b39efb42f18115b3a9d29c5"
    );
  })
);

layer(BunCrypto.layer)("PAT bearer digest", (it) => {
  it.effect("derives a one-way digest without returning bearer material", () =>
    Effect.gen(function* () {
      const bearer = TokenBearer.make("fin_abcd1234_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef");
      const digest = yield* derivePATBearerDigest(bearer);

      expect(digest).toBe("b3296e85c2a10b146667cc5a8677a34be723fcf7ef216e8b73190f2046d2358e");
      expect(digest).not.toContain(bearer);
    })
  );
});
