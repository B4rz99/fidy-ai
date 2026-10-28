import { expect, it } from "@effect/vitest";
import { Context, Crypto, Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { TestCrypto } from "../../src/shell/testing/crypto-harness";
import { BancolombiaAuthorizationFailed } from "./contract";
import { revokeBancolombiaSandboxGrant } from "./operations";

const as = "https://as1-api-open-finance-sandbox.ambientesbc.com";
const clientId = "10000000-0000-4000-8000-000000000001";
type Scenario =
  | "ready"
  | "refresh-rejected"
  | "still-active"
  | "inactive-before"
  | "foreign-client"
  | "unauthorized"
  | "endpoint-drift"
  | "access-only"
  | "expired-access"
  | "proof-write";
const inspectResponse = (scenario: Scenario, active: boolean, hint: string): Response =>
  scenario === "unauthorized"
    ? new Response(null, { status: 401 })
    : Response.json({
        active:
          scenario === "inactive-before" ||
          (scenario === "expired-access" && hint === "access_token")
            ? false
            : scenario === "still-active" || active,
        client_id: scenario === "foreign-client" ? "other-client" : clientId,
      });
const cleanup = Effect.fn(function* (scenario: Scenario) {
  const crypto = Context.get(yield* Layer.build(TestCrypto), Crypto.Crypto);
  const key = yield* Effect.tryPromise(() => generateKeyPair("RS256", { extractable: true }));
  const revoked = new Set<string>();
  const requests: string[] = [];
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.method === "GET") {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            issuer: "https://auth1-api-open-finance-sandbox.ambientesbc.com",
            token_endpoint: `${as}/token`,
            token_endpoint_auth_methods_supported: ["private_key_jwt"],
            token_endpoint_auth_signing_alg_values_supported: ["RS256"],
            tls_client_certificate_bound_access_tokens: true,
            revocation_endpoint:
              scenario === "endpoint-drift"
                ? "https://attacker.invalid/revoke"
                : `${as}/token/revoke`,
            introspection_endpoint: `${as}/introspection`,
            mtls_endpoint_aliases: {
              token_endpoint: `${as}/token`,
              revocation_endpoint: `${as}/token/revoke`,
              introspection_endpoint: `${as}/introspection`,
            },
          })
        );
      }
      if (request.body._tag !== "Uint8Array") throw new Error("Expected form");
      const form = new URLSearchParams(new TextDecoder().decode(request.body.body));
      const token = yield* Schema.decodeUnknownEffect(Schema.String)(form.get("token"));
      const hint = yield* Schema.decodeUnknownEffect(Schema.String)(form.get("token_type_hint"));
      requests.push(`${request.url}:${hint}`);
      if (request.url === `${as}/token/revoke`) {
        const rejected = scenario === "refresh-rejected" && hint === "refresh_token";
        if (!rejected) revoked.add(token);
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, { status: rejected ? 503 : 200 })
        );
      }
      return HttpClientResponse.fromWeb(
        request,
        inspectResponse(scenario, !revoked.has(token), hint)
      );
    }).pipe(Effect.orDie)
  );
  const result = yield* revokeBancolombiaSandboxGrant({
    crypto,
    clientId,
    httpClient,
    privateKey: Redacted.make(yield* Effect.tryPromise(() => exportPKCS8(key.privateKey))),
    publicKey: {
      ...(yield* Effect.tryPromise(() => exportJWK(key.publicKey))),
      kid: "test",
      alg: "RS256",
    },
    proof:
      scenario === "proof-write"
        ? Option.some({
            observedTokens: [],
            recordActive: () => Effect.fail(new BancolombiaAuthorizationFailed()),
          })
        : Option.none(),
    grant: {
      accessToken: Redacted.make("synthetic-access"),
      refreshToken:
        scenario === "access-only"
          ? Option.none()
          : Option.some(Redacted.make("synthetic-refresh")),
      expiresAtMilliseconds: scenario === "expired-access" ? 0 : 300000,
    },
  }).pipe(Effect.exit);
  return { result, revoked, requests };
});
it.effect(
  "revokes both held customer tokens and verifies they are inactive without obtaining new authority",
  () =>
    Effect.gen(function* () {
      const { result, revoked, requests } = yield* cleanup("ready");
      expect(Exit.isSuccess(result)).toBe(true);
      expect([...revoked]).toEqual(["synthetic-refresh", "synthetic-access"]);
      expect(requests).toEqual([
        `${as}/introspection:refresh_token`,
        `${as}/introspection:access_token`,
        `${as}/token/revoke:refresh_token`,
        `${as}/introspection:refresh_token`,
        `${as}/token/revoke:access_token`,
        `${as}/introspection:access_token`,
      ]);
    })
);
it.effect(
  "still attempts access-token cleanup when refresh revocation fails and refuses completion",
  () =>
    Effect.gen(function* () {
      const { result, revoked } = yield* cleanup("refresh-rejected");
      expect(Exit.isFailure(result)).toBe(true);
      expect([...revoked]).toEqual(["synthetic-access"]);
    })
);

it.effect.each([
  "still-active",
  "foreign-client",
  "unauthorized",
  "endpoint-drift",
  "inactive-before",
  "proof-write",
] as const)("refuses %s as completed customer cleanup", (scenario) =>
  Effect.gen(function* () {
    const { result, revoked } = yield* cleanup(scenario);
    expect(Exit.isFailure(result)).toBe(true);
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result);
    expect(encoded).not.toContain("synthetic-access");
    expect(encoded).not.toContain("synthetic-refresh");
    if (scenario !== "still-active") expect([...revoked]).toEqual([]);
  })
);
it.effect("cleans a grant that has no refresh token", () =>
  Effect.gen(function* () {
    const { result, revoked } = yield* cleanup("access-only");
    expect(Exit.isSuccess(result)).toBe(true);
    expect([...revoked]).toEqual(["synthetic-access"]);
  })
);

it.effect("can clean an expired access token alongside a positively inspected refresh token", () =>
  Effect.gen(function* () {
    const { result, revoked } = yield* cleanup("expired-access");
    expect(Exit.isSuccess(result)).toBe(true);
    expect([...revoked]).toEqual(["synthetic-refresh", "synthetic-access"]);
  })
);
