import { TestCrypto } from "../../src/shell/testing/crypto-harness";
import { expect, it } from "@effect/vitest";
import { Context, Crypto, Data, DateTime, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { authenticateBancolombiaSandbox } from "./operations";

const issuer = "https://auth1-api-open-finance-sandbox.ambientesbc.com";
const token = "https://as1-api-open-finance-sandbox.ambientesbc.com/token";
const clientId = "10000000-0000-4000-8000-000000000001";

class SyntheticAssertionFailed extends Data.TaggedError("SyntheticAssertionFailed") {}

const verifyAssertion = Effect.fn(function* (assertion: string, key: CryptoKey) {
  return yield* Effect.tryPromise({
    try: () =>
      jwtVerify(assertion, key, {
        issuer: clientId,
        subject: clientId,
        audience: issuer,
        algorithms: ["RS256"],
        currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
      }),
    catch: () => new SyntheticAssertionFailed(),
  }).pipe(Effect.orDie);
});

it.effect(
  "authenticates accounts with a matching RS256 key and retains no bearer in its result",
  () =>
    Effect.gen(function* () {
      const crypto = Context.get(yield* Layer.build(TestCrypto), Crypto.Crypto);
      const key = yield* Effect.tryPromise(() => generateKeyPair("RS256", { extractable: true }));
      const publicKey = {
        ...(yield* Effect.tryPromise(() => exportJWK(key.publicKey))),
        kid: "synthetic-bank-key",
        alg: "RS256",
      };
      const privateKey = Redacted.make(yield* Effect.tryPromise(() => exportPKCS8(key.privateKey)));
      const requests: string[] = [];
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request.url);
          if (request.method === "GET") {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                issuer,
                token_endpoint: token,
                token_endpoint_auth_methods_supported: ["private_key_jwt"],
                token_endpoint_auth_signing_alg_values_supported: ["RS256", "PS256"],
                tls_client_certificate_bound_access_tokens: true,
                mtls_endpoint_aliases: { token_endpoint: token },
              })
            );
          }
          expect(request.body._tag).toBe("Uint8Array");
          if (request.body._tag !== "Uint8Array") throw new Error("Expected form body");
          const form = new URLSearchParams(new TextDecoder().decode(request.body.body));
          expect(form.get("grant_type")).toBe("client_credentials");
          expect(form.get("scope")).toBe("accounts");
          const assertion = form.get("client_assertion");
          expect(assertion).toBeTypeOf("string");
          if (assertion === null) throw new Error("Missing assertion");
          const checked = yield* verifyAssertion(assertion, key.publicKey);
          expect(checked.protectedHeader.kid).toBe("synthetic-bank-key");
          expect(checked.payload.exp).toBe(300);
          expect(checked.payload.iat).toBe(0);
          expect(checked.payload.jti).toMatch(/^[0-9a-f-]{36}$/u);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              access_token: "synthetic-bank-bearer",
              token_type: "Bearer",
              expires_in: 300,
              scope: "accounts",
            })
          );
        })
      );
      const result = yield* authenticateBancolombiaSandbox({
        crypto,
        clientId,
        privateKey,
        publicKey,
        httpClient,
      });
      expect(result).toBeUndefined();
      expect(requests).toEqual([`${issuer}/.well-known/openid-configuration`, token]);
    })
);

it.effect("refuses a signing key that does not match registration before sending any request", () =>
  Effect.gen(function* () {
    const crypto = Context.get(yield* Layer.build(TestCrypto), Crypto.Crypto);
    const registered = yield* Effect.tryPromise(() =>
      generateKeyPair("RS256", { extractable: true })
    );
    const unrelated = yield* Effect.tryPromise(() =>
      generateKeyPair("RS256", { extractable: true })
    );
    let calls = 0;
    const publicKey = {
      ...(yield* Effect.tryPromise(() => exportJWK(registered.publicKey))),
      kid: "registered",
      alg: "RS256",
    };
    const result = yield* authenticateBancolombiaSandbox({
      crypto,
      clientId,
      publicKey,
      privateKey: Redacted.make(yield* Effect.tryPromise(() => exportPKCS8(unrelated.privateKey))),
      httpClient: HttpClient.make((request) => {
        calls += 1;
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
      }),
    }).pipe(Effect.result);
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result)).not.toContain(
      "PRIVATE KEY"
    );
    expect(calls).toBe(0);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.stage).toBe("bancolombia_signing");
  })
);

it.effect("refuses issuer or token-endpoint drift before any credential-bearing request", () =>
  Effect.gen(function* () {
    const crypto = Context.get(yield* Layer.build(TestCrypto), Crypto.Crypto);
    const key = yield* Effect.tryPromise(() => generateKeyPair("RS256", { extractable: true }));
    const publicKey = {
      ...(yield* Effect.tryPromise(() => exportJWK(key.publicKey))),
      kid: "registered",
      alg: "RS256",
    };
    const privateKey = Redacted.make(yield* Effect.tryPromise(() => exportPKCS8(key.privateKey)));
    for (const metadata of [
      { issuer: "https://foreign.example", token_endpoint: token },
      { issuer, token_endpoint: "http://127.0.0.1/token" },
      { issuer, token_endpoint: token, token_endpoint_auth_signing_alg_values_supported: ["none"] },
    ]) {
      let calls = 0;
      const result = yield* authenticateBancolombiaSandbox({
        crypto,
        clientId,
        publicKey,
        privateKey,
        httpClient: HttpClient.make((request) => {
          calls += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                token_endpoint_auth_methods_supported: ["private_key_jwt"],
                token_endpoint_auth_signing_alg_values_supported: ["RS256"],
                tls_client_certificate_bound_access_tokens: true,
                mtls_endpoint_aliases: { token_endpoint: token },
                ...metadata,
              })
            )
          );
        }),
      }).pipe(Effect.result);
      expect(calls).toBe(1);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.stage).toBe("bancolombia_discovery");
    }
  })
);

it.effect("does not retry bank rejection or expose its body or a malformed token", () =>
  Effect.gen(function* () {
    const crypto = Context.get(yield* Layer.build(TestCrypto), Crypto.Crypto);
    const key = yield* Effect.tryPromise(() => generateKeyPair("RS256", { extractable: true }));
    const publicKey = {
      ...(yield* Effect.tryPromise(() => exportJWK(key.publicKey))),
      kid: "registered",
      alg: "RS256",
    };
    const privateKey = Redacted.make(yield* Effect.tryPromise(() => exportPKCS8(key.privateKey)));
    for (const rejection of [
      { status: 401, body: { error: "synthetic-secret-provider-body" } },
      {
        status: 200,
        body: {
          access_token: "synthetic-secret-provider-body",
          token_type: "Bearer",
          expires_in: -1,
        },
      },
    ]) {
      let posts = 0;
      const result = yield* authenticateBancolombiaSandbox({
        crypto,
        clientId,
        publicKey,
        privateKey,
        httpClient: HttpClient.make((request) => {
          if (request.method === "GET") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  issuer,
                  token_endpoint: token,
                  token_endpoint_auth_methods_supported: ["private_key_jwt"],
                  token_endpoint_auth_signing_alg_values_supported: ["RS256"],
                  tls_client_certificate_bound_access_tokens: true,
                  mtls_endpoint_aliases: { token_endpoint: token },
                })
              )
            );
          }
          posts += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(rejection.body, { status: rejection.status })
            )
          );
        }),
      }).pipe(Effect.result);
      expect(posts).toBe(1);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.stage).toBe("bancolombia_authentication");
      }
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result)
      ).not.toContain("synthetic-secret-provider-body");
    }
  })
);
