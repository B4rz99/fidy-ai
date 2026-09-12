import { createHash, createHmac } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { Cause, type Config, ConfigProvider, Effect, Encoding, Exit } from "effect";
import {
  type AnonymousSourcePurpose,
  anonymousSourceIdentifier,
} from "./anonymous-source-identifier";

const productionKey = "ab".repeat(32);
const rotatedKey = "cd".repeat(32);
const address = "203.0.113.9";

const deriveIdentifier = (
  purpose: AnonymousSourcePurpose,
  sourceAddress: string,
  environment: Readonly<Record<string, string>>
): Effect.Effect<string, Config.ConfigError> =>
  anonymousSourceIdentifier(purpose, sourceAddress).pipe(
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
