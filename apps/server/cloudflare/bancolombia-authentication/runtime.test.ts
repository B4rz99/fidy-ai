import * as assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Schema } from "effect";
import { ConnectionAuthorizationUnavailable } from "../connections/contract";
import { UserId } from "../../src/core/identity/contract";
import { ConnectionAttemptReference } from "../../src/shell/connections/contract";
import { BancolombiaAuthenticationFailed } from "./contract";
import {
  makeBancolombiaSandboxPreparation,
  verifyBancolombiaSandboxAuthentication,
} from "./runtime";

const userId = "10000000-0000-4000-8000-000000000001";
const profile = {
  contract: "bancolombia-sandbox-consent-2026-10-27",
  userId,
  admission: { startsAt: "1970-01-01T00:00:00.000Z", expiresAt: "1970-01-01T00:10:00.000Z" },
  financialId: "synthetic-participant",
  accountOwner: { SchemeName: "CC", Identification: "synthetic-identity" },
  intent: {
    permissions: ["ReadAccountsBasic"],
    historyPolicy: "bank-default",
    expiryPolicy: "bank-default",
  },
};

it.effect(
  "refuses absent certificate or incomplete client configuration without a network fallback",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const binding = {
        fetch: (): Promise<Response> => {
          calls += 1;
          return Promise.resolve(Response.json({}));
        },
      };
      for (const environment of [
        {},
        {
          BANCOLOMBIA_SANDBOX_CLIENT_ID: "10000000-0000-4000-8000-000000000001",
          BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM: "synthetic-key",
        },
        { BANCOLOMBIA_SANDBOX_MTLS: binding },
        {
          BANCOLOMBIA_SANDBOX_MTLS: binding,
          BANCOLOMBIA_SANDBOX_CLIENT_ID: "invalid",
          BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM: "synthetic-key",
        },
      ]) {
        const result = yield* verifyBancolombiaSandboxAuthentication(environment).pipe(Effect.exit);
        assert.deepStrictEqual(
          result,
          Exit.fail(new BancolombiaAuthenticationFailed({ stage: "bancolombia_configuration" }))
        );
      }
      expect(calls).toBe(0);
    })
);

it("installs only a bounded, matching-User support-collection sandbox profile", () => {
  const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  for (const configured of [
    undefined,
    "{",
    "x".repeat(10000),
    encode({ ...profile, userId: "10000000-0000-4000-8000-000000000002" }),
    encode({ ...profile, contract: "unknown" }),
    encode({
      ...profile,
      contract: "869a3da43fed9043b734e9be698e49234738cb3b1a26ca79cde3f606eb3fcd62",
    }),
    encode({ ...profile, intent: { ...profile.intent, permissions: ["ReadAccountBasic"] } }),
    encode({ ...profile, financialId: "\n" }),
    encode({ ...profile, customerIpAddress: "Mon, 19 Oct 2018 08:51:49 GMT" }),
  ]) {
    expect(
      makeBancolombiaSandboxPreparation({
        environment: { BANCOLOMBIA_SANDBOX_CONSENT_PROFILE: configured },
        userId,
      })
    ).toEqual(Option.none());
  }
  expect(
    Option.isSome(
      makeBancolombiaSandboxPreparation({
        environment: { BANCOLOMBIA_SANDBOX_CONSENT_PROFILE: encode(profile) },
        userId,
      })
    )
  ).toBe(true);
  expect(
    Option.isSome(
      makeBancolombiaSandboxPreparation({
        environment: {
          BANCOLOMBIA_SANDBOX_CONSENT_PROFILE: encode({ ...profile, financialId: "" }),
        },
        userId,
      })
    )
  ).toBe(true);
});

it.effect("refuses missing mTLS through the admitted profile preparation boundary", () =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(profile);
    const bank = Option.getOrThrow(
      makeBancolombiaSandboxPreparation({
        environment: {
          BANCOLOMBIA_SANDBOX_CONSENT_PROFILE: encoded,
          BANCOLOMBIA_SANDBOX_CLIENT_ID: userId,
          BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM: "synthetic-key",
        },
        userId,
      })
    );
    const result = yield* bank
      .prepare({
        userId: yield* Schema.decodeEffect(UserId)(userId),
        attempt: yield* Schema.decodeEffect(ConnectionAttemptReference)(userId),
        state: "s".repeat(43),
        challenge: "c".repeat(43),
        expiresAtMilliseconds: 600000,
        recordConsent: () => Effect.void,
      })
      .pipe(Effect.exit);
    assert.deepStrictEqual(result, Exit.fail(new ConnectionAuthorizationUnavailable()));
  })
);
