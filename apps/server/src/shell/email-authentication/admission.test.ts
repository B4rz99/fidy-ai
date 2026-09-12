import assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import { Cause, Config, ConfigProvider, Effect, Exit } from "effect";
import { EmailAddress } from "~/core/email-authentication/model";
import { emailAuthenticationHmacKey, emailCredentialLookupKey } from "./admission";

// OpenSSL dgst -sha256 -mac HMAC -macopt hexkey:abab...ab (64 characters, 32 decoded bytes)
const hexadecimalKey = "ab".repeat(32);
const production = (configuration: string, key: string): ConfigProvider.ConfigProvider =>
  ConfigProvider.fromEnv({ env: { NODE_ENV: "production", [configuration]: key } });
const lookupEmail = EmailAddress.make("lookup-key@example.com");
const admissionScope = "user:f1d1a000-0000-4000-8000-000000000101";

it.effect("derives lookup and admission keys from the exact decoded 32 key bytes", () =>
  Effect.gen(function* () {
    const lookup = yield* emailCredentialLookupKey(lookupEmail).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        production("EMAIL_CREDENTIAL_LOOKUP_HMAC_KEY", hexadecimalKey)
      )
    );
    expect(lookup).toBe("61dbd8c605dcea93794d0466a317794d784683802deaaeeb5e96058a7e8e5db9");
    // The previous contract used the 64-character text as a 64-byte HMAC key; that value is gone.
    expect(lookup).not.toBe("f666976f0cdec1fa84e35560ed07b7c6fe15550c9a6cf0f18d86fb0aa8ffd4bf");

    const admission = yield* emailAuthenticationHmacKey(admissionScope).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        production("EMAIL_ADMISSION_HMAC_KEY", hexadecimalKey)
      )
    );
    expect(admission).toBe("050789e53f5a91a014af4d6edd45d5efbc89b9f550899dc0cbe404e27853f44e");
  })
);

it.effect("rejects malformed hexadecimal key encodings in production", () =>
  Effect.gen(function* () {
    const malformed = [
      "malformed",
      "a".repeat(63),
      `${hexadecimalKey}00`,
      "z".repeat(64),
      "AB".repeat(32),
    ];
    for (const key of malformed) {
      assert.deepStrictEqual(
        Exit.match(
          yield* emailCredentialLookupKey(lookupEmail).pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              production("EMAIL_CREDENTIAL_LOOKUP_HMAC_KEY", key)
            ),
            Effect.exit
          ),
          {
            onFailure: (cause) => Exit.fail(Cause.squash(cause)),
            onSuccess: Exit.succeed,
          }
        ),
        Exit.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message:
                "EMAIL_CREDENTIAL_LOOKUP_HMAC_KEY must be a 32-byte lowercase hexadecimal key",
            })
          )
        )
      );
    }
  })
);

it.effect("keeps the development fallback keys unchanged", () =>
  Effect.gen(function* () {
    expect(yield* emailCredentialLookupKey(lookupEmail)).toBe(
      "feed69ddcde5e1ee42a78840f6c0822be35ef66be69fb56fd83c0db51b3ce06b"
    );
    expect(yield* emailAuthenticationHmacKey(admissionScope)).toBe(
      "37c2071c7caf830f8c05b729d0a411efb0d5f6d95b39efb42f18115b3a9d29c5"
    );
  })
);
