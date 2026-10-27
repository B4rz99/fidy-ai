import * as assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Schema } from "effect";
import { BancolombiaAuthenticationFailed, BancolombiaAuthorizationFailed } from "./contract";
import {
  makeBancolombiaSandboxPreparation,
  prepareBancolombiaSandboxAuthorization,
  verifyBancolombiaSandboxAuthentication,
} from "./runtime";

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

it.effect(
  "requires the private mTLS binding for PAR rather than falling back to ordinary fetch",
  () =>
    Effect.gen(function* () {
      const result = yield* prepareBancolombiaSandboxAuthorization({
        environment: {
          BANCOLOMBIA_SANDBOX_CLIENT_ID: "10000000-0000-4000-8000-000000000001",
          BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM: "synthetic-key",
        },
        request: {
          consentId: "synthetic-consent",
          state: "s".repeat(43),
          nonce: "n".repeat(43),
          challenge: "c".repeat(43),
          expiresAtMilliseconds: 600000,
        },
      }).pipe(Effect.exit);
      assert.deepStrictEqual(result, Exit.fail(new BancolombiaAuthorizationFailed()));
    })
);

it("installs only a bounded, matching-User public-contract sandbox profile", () => {
  const userId = "10000000-0000-4000-8000-000000000001";
  const profile = {
    contract: "b794218bd9dbf50f68b20aa2335e552ecfb5734830a9fc1c36e70622b5928650",
    userId,
    financialId: "synthetic-participant",
    accountOwner: { SchemeName: "CC", Identification: "synthetic-identity" },
    intent: {
      permissions: ["ReadAccountsBasic"],
      historyFrom: "1969-12-31T00:00:00.000Z",
      historyTo: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-04-01T00:00:00.000Z",
    },
  };
  const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  for (const configured of [
    undefined,
    "{",
    "x".repeat(10000),
    encode({ ...profile, userId: "10000000-0000-4000-8000-000000000002" }),
    encode({ ...profile, contract: "unknown" }),
    encode({ ...profile, financialId: "" }),
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
});
