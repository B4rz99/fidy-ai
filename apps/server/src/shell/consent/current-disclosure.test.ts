import { expect, it } from "@effect/vitest";
import { ConfigProvider, Data, Effect } from "effect";
import { currentDisclosure } from "./operations";

class PolicyFixtureUnavailable extends Data.TaggedError("PolicyFixtureUnavailable")<{}> {}

const sha256 = (content: string | Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(content).digest("hex");

const TestPublicNamespace = ConfigProvider.fromEnv({
  env: {
    PUBLIC_WEB_ORIGIN: "https://fidyapp.com",
    PUBLIC_API_ORIGIN: "https://api.fidyapp.com",
  },
});

const loadCurrentDisclosure = currentDisclosure.pipe(
  Effect.provideService(ConfigProvider.ConfigProvider, TestPublicNamespace)
);

it.effect("pins the exact chat disclosure and web-owned policy metadata", () =>
  Effect.gen(function* () {
    const disclosure = yield* loadCurrentDisclosure;

    expect(sha256(disclosure.text)).toBe(disclosure.contentSha256);
    const policy = yield* Effect.tryPromise({
      try: () =>
        Bun.file(
          new URL("../../../../web/src/features/public-site/legal/policy.html", import.meta.url)
        ).bytes(),
      catch: () => new PolicyFixtureUnavailable(),
    });
    expect(sha256(policy)).toBe(disclosure.policy.contentSha256);
  })
);

it.effect("uses the canonical stable policy URL and complete Colombia-first facts", () =>
  Effect.gen(function* () {
    const disclosure = yield* loadCurrentDisclosure;

    expect(disclosure.policy.publicUrl).toBe("https://app.fidyapp.com/politica");
    expect(disclosure.serviceMarket).toBe("CO");
    expect(disclosure.locale).toBe("es-CO");
    expect(disclosure.purposes.length).toBeGreaterThan(0);
    expect(disclosure.dataCategories.length).toBeGreaterThan(0);
    expect(disclosure.duration.length).toBeGreaterThan(0);
    expect(disclosure.revocationMethod).toContain("obarboza@fidyapp.com");
  })
);
