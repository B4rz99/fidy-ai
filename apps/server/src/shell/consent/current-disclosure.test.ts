import { createHash } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { CURRENT_DISCLOSURE_TEXT, currentDisclosure } from "./current-disclosure";

const sha256 = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

const TestPublicNamespace = ConfigProvider.fromEnv({
  env: {
    PUBLIC_WEB_ORIGIN: "https://fidyapp.com",
    PUBLIC_API_ORIGIN: "https://api.fidyapp.com",
    INGEST_EMAIL_DOMAIN: "ingest.fidyapp.com",
  },
});

const loadCurrentDisclosure = currentDisclosure.pipe(
  Effect.provideService(ConfigProvider.ConfigProvider, TestPublicNamespace)
);

it.effect("pins the exact chat disclosure and web-owned policy metadata", () =>
  Effect.gen(function* () {
    const disclosure = yield* loadCurrentDisclosure;

    expect(sha256(CURRENT_DISCLOSURE_TEXT)).toBe(disclosure.contentSha256);
    expect(disclosure.policy.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
  })
);

it.effect("uses the canonical stable policy URL and complete Colombia-first facts", () =>
  Effect.gen(function* () {
    const disclosure = yield* loadCurrentDisclosure;

    expect(disclosure.policy.publicUrl).toBe("https://fidyapp.com/politica");
    expect(disclosure.serviceMarket).toBe("CO");
    expect(disclosure.locale).toBe("es-CO");
    expect(disclosure.purposes.length).toBeGreaterThan(0);
    expect(disclosure.dataCategories.length).toBeGreaterThan(0);
    expect(disclosure.duration.length).toBeGreaterThan(0);
    expect(disclosure.revocationMethod).toContain("obarboza@fidyapp.com");
  })
);
