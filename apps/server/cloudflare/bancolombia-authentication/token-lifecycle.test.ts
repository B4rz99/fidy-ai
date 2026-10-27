import * as assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import { Cause, Context, Crypto, DateTime, Effect, Exit, Layer, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { TestCrypto } from "../../src/shell/testing/crypto-harness";
import { BancolombiaAuthenticationFailed } from "./contract";
import { verifyBancolombiaSandboxTokenLifecycle } from "./operations";

const issuer = "https://auth1-api-open-finance-sandbox.ambientesbc.com";
const as = "https://as1-api-open-finance-sandbox.ambientesbc.com";
const clientId = "10000000-0000-4000-8000-000000000001";

type Scenario =
  | "ready"
  | "inactive-before"
  | "unauthorized-inspection"
  | "revocation-rejected"
  | "expired-during"
  | "still-active"
  | "foreign-client"
  | "endpoint-drift";
const discoveryResponse = (scenario: Scenario): Response =>
  Response.json({
    issuer,
    token_endpoint: `${as}/token`,
    token_endpoint_auth_methods_supported: ["private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["RS256"],
    tls_client_certificate_bound_access_tokens: true,
    revocation_endpoint:
      scenario === "endpoint-drift" ? "https://attacker.invalid/revoke" : `${as}/token/revoke`,
    introspection_endpoint: `${as}/introspection`,
    mtls_endpoint_aliases: {
      token_endpoint: `${as}/token`,
      revocation_endpoint: `${as}/token/revoke`,
      introspection_endpoint: `${as}/introspection`,
    },
  });
const verifiedForm = Effect.fn(function* (
  request: HttpClientRequest.HttpClientRequest,
  key: CryptoKey,
  assertions: Set<string>
) {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected form");
  const form = new URLSearchParams(new TextDecoder().decode(request.body.body));
  const assertion = form.get("client_assertion");
  if (assertion === null) throw new Error("Missing assertion");
  const verified = yield* Effect.tryPromise(() =>
    jwtVerify(assertion, key, {
      issuer: clientId,
      subject: clientId,
      audience: issuer,
      algorithms: ["RS256"],
      currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
    })
  );
  if (verified.payload.jti === undefined) throw new Error("Missing assertion identity");
  expect(assertions.has(verified.payload.jti)).toBe(false);
  assertions.add(verified.payload.jti);
  expect(request.headers.authorization).toBeUndefined();
  return form;
});
const introspectionResponse = (scenario: Scenario, revoked: boolean): Response => {
  if (scenario === "unauthorized-inspection") return new Response(null, { status: 401 });
  return Response.json({
    active: scenario === "inactive-before" ? false : scenario === "still-active" || !revoked,
    client_id: scenario === "foreign-client" ? "other-client" : clientId,
  });
};
const lifecycle = Effect.fn(function* (scenario: Scenario) {
  const crypto = Context.get(yield* Layer.build(TestCrypto), Crypto.Crypto);
  const key = yield* Effect.tryPromise(() => generateKeyPair("RS256", { extractable: true }));
  const publicKey = {
    ...(yield* Effect.tryPromise(() => exportJWK(key.publicKey))),
    kid: "test",
    alg: "RS256",
  };
  const assertions = new Set<string>();
  const requests: string[] = [];
  let revoked = false;
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      requests.push(request.url);
      if (request.method === "GET") {
        return HttpClientResponse.fromWeb(request, discoveryResponse(scenario));
      }
      const form = yield* verifiedForm(request, key.publicKey, assertions).pipe(Effect.orDie);
      if (request.url === `${as}/token`) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            access_token: "synthetic-lifecycle-token",
            token_type: "Bearer",
            expires_in: scenario === "expired-during" ? 1 : 300,
            scope: "accounts",
          })
        );
      }
      expect(form.get("token")).toBe("synthetic-lifecycle-token");
      expect(form.get("token_type_hint")).toBe("access_token");
      expect(form.get("grant_type")).toBeNull();
      if (request.url === `${as}/token/revoke`) {
        revoked = true;
        if (scenario === "expired-during") yield* TestClock.adjust("2 seconds");
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, { status: scenario === "revocation-rejected" ? 400 : 200 })
        );
      }
      expect(request.url).toBe(`${as}/introspection`);
      return HttpClientResponse.fromWeb(request, introspectionResponse(scenario, revoked));
    })
  );
  const result = yield* verifyBancolombiaSandboxTokenLifecycle({
    crypto,
    clientId,
    publicKey,
    privateKey: Redacted.make(yield* Effect.tryPromise(() => exportPKCS8(key.privateKey))),
    httpClient,
  }).pipe(Effect.exit);
  return { result, requests };
});

it.effect(
  "proves an application token active before revocation and inactive afterwards with fresh signed authentication",
  () =>
    Effect.gen(function* () {
      const { result, requests } = yield* lifecycle("ready");
      expect(Exit.isSuccess(result)).toBe(true);
      expect(requests).toEqual([
        `${issuer}/.well-known/openid-configuration`,
        `${as}/token`,
        `${as}/introspection`,
        `${as}/token/revoke`,
        `${as}/introspection`,
      ]);
    })
);

it.effect.each([
  "inactive-before",
  "unauthorized-inspection",
  "revocation-rejected",
  "still-active",
  "expired-during",
  "foreign-client",
  "endpoint-drift",
] as const)(
  "refuses %s as token cleanup evidence without leaking authority or retrying",
  (scenario) =>
    Effect.gen(function* () {
      const { result, requests } = yield* lifecycle(scenario);
      assert.ok(Exit.isFailure(result));
      assert.deepStrictEqual(
        result,
        Exit.failCause(
          Cause.annotate(
            Cause.fail(
              new BancolombiaAuthenticationFailed({ stage: "bancolombia_token_lifecycle" })
            ),
            Cause.annotations(result.cause)
          )
        )
      );
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result);
      expect(encoded).not.toContain("synthetic-lifecycle-token");
      expect(encoded).not.toContain("PRIVATE KEY");
      expect(requests.filter((url) => url === `${as}/token/revoke`)).toHaveLength(
        scenario === "endpoint-drift" ? 0 : 1
      );
      if (scenario === "endpoint-drift") {
        expect(requests).toEqual([`${issuer}/.well-known/openid-configuration`]);
      }
    })
);
