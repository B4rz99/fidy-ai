import { createHash } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import {
  currentDisclosure,
  CURRENT_DISCLOSURE_TEXT,
  CURRENT_POLICY_PATH,
} from "./current-disclosure";

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

it.effect("pins the exact chat disclosure and source-controlled policy bytes", () =>
  Effect.gen(function* () {
    const disclosure = yield* loadCurrentDisclosure;
    const policyBuffer = yield* Effect.promise(() => Bun.file(CURRENT_POLICY_PATH).arrayBuffer());
    const policyBytes = new Uint8Array(policyBuffer);
    const policyText = new TextDecoder().decode(policyBytes);

    expect(sha256(CURRENT_DISCLOSURE_TEXT)).toBe(disclosure.contentSha256);
    expect(sha256(policyBytes)).toBe(disclosure.policy.contentSha256);
    expect(policyText).toContain("OpenAI");
    expect(policyText).toMatch(/Estados\s+Unidos/u);
    expect(policyText).not.toMatch(/cuentas|saldos/iu);
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
