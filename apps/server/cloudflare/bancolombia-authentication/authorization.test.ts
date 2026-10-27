import * as assert from "node:assert/strict";
import { BancolombiaAuthorizationFailed, BancolombiaConsentProfile } from "./contract";
import { expect, it } from "@effect/vitest";
import {
  type Cause,
  Context,
  Crypto,
  DateTime,
  Effect,
  Exit,
  Layer,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { TestCrypto } from "../../src/shell/testing/crypto-harness";
import { authorizeBancolombiaSandbox, pushBancolombiaSandboxAuthorization } from "./operations";

const issuer = "https://auth1-api-open-finance-sandbox.ambientesbc.com";
const as = "https://as1-api-open-finance-sandbox.ambientesbc.com";
const clientId = "10000000-0000-4000-8000-000000000001";
const state = "s".repeat(43);
const challenge = "c".repeat(43);

const signing = Effect.gen(function* () {
  const crypto = Context.get(yield* Layer.build(TestCrypto), Crypto.Crypto);
  const key = yield* Effect.tryPromise(() => generateKeyPair("RS256", { extractable: true }));
  const publicKey = {
    ...(yield* Effect.tryPromise(() => exportJWK(key.publicKey))),
    kid: "synthetic-key",
    alg: "RS256",
  };
  const privateKey = Redacted.make(yield* Effect.tryPromise(() => exportPKCS8(key.privateKey)));
  return { crypto, key, publicKey, privateKey };
});
const discovery = {
  issuer,
  token_endpoint: `${as}/token`,
  authorization_endpoint: `${issuer}/auth`,
  pushed_authorization_request_endpoint: `${as}/par`,
  token_endpoint_auth_methods_supported: ["private_key_jwt"],
  token_endpoint_auth_signing_alg_values_supported: ["RS256"],
  code_challenge_methods_supported: ["S256"],
  tls_client_certificate_bound_access_tokens: true,
  mtls_endpoint_aliases: {
    token_endpoint: `${as}/token`,
    pushed_authorization_request_endpoint: `${as}/par`,
  },
};
const checkPar = (
  request: HttpClientRequest.HttpClientRequest,
  publicKey: CryptoKey
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (request.body._tag !== "Uint8Array") throw new Error("Expected encoded PAR");
    const form = new URLSearchParams(new TextDecoder().decode(request.body.body));
    expect(
      Object.fromEntries(Array.from(form).filter(([name]) => name !== "client_assertion"))
    ).toEqual({
      client_id: clientId,
      redirect_uri: "https://api.fidyapp.com/connections/bancolombia/sandbox/callback",
      scope: "accounts:synthetic-consent openid",
      state,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    });
    const checked = yield* Effect.tryPromise(() =>
      jwtVerify(form.get("client_assertion") ?? "", publicKey, {
        algorithms: ["RS256"],
        issuer: clientId,
        subject: clientId,
        audience: issuer,
        currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
      })
    ).pipe(Effect.orDie);
    expect(checked.payload).toMatchObject({ iat: 0, exp: 300 });
    expect(checked.payload.jti).toMatch(/^[0-9a-f-]{36}$/u);
  });
it.effect(
  "pushes the exact consent, S256 and state with a locally signed assertion and returns only the bounded bank handoff",
  () =>
    Effect.gen(function* () {
      const { crypto, key, publicKey, privateKey } = yield* signing;
      const urls: string[] = [];
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          urls.push(request.url);
          if (request.method === "GET") {
            return HttpClientResponse.fromWeb(request, Response.json(discovery));
          }
          yield* checkPar(request, key.publicKey);
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              {
                request_uri: "urn:ietf:params:oauth:request_uri:synthetic",
                expires_in: 90,
              },
              { status: 201 }
            )
          );
        })
      );
      const result = yield* pushBancolombiaSandboxAuthorization({
        crypto,
        clientId,
        privateKey,
        publicKey,
        httpClient,
        consentId: "synthetic-consent",
        state,
        challenge,
        expiresAtMilliseconds: 600000,
      });
      const url = new URL(result.url);
      expect(url.origin + url.pathname).toBe(`${issuer}/auth`);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: clientId,
        response_type: "code",
        scope: "accounts",
        request_uri: "urn:ietf:params:oauth:request_uri:synthetic",
      });
      expect(result.expiresAtMilliseconds).toBe(90000);
      expect(urls).toEqual([`${issuer}/.well-known/openid-configuration`, `${as}/par`]);
    })
);

it.effect("refuses hostile discovery before disclosing a signed PAR assertion", () =>
  Effect.gen(function* () {
    const keys = yield* signing;
    for (const changed of [
      { authorization_endpoint: "https://foreign.example/auth" },
      { pushed_authorization_request_endpoint: "http://127.0.0.1/par" },
      { issuer: "https://foreign.example" },
      {
        mtls_endpoint_aliases: {
          token_endpoint: `${as}/token`,
          pushed_authorization_request_endpoint: "https://foreign.example/par",
        },
      },
      { code_challenge_methods_supported: ["plain"] },
    ]) {
      const urls: string[] = [];
      const result = yield* pushBancolombiaSandboxAuthorization({
        ...keys,
        clientId,
        consentId: "synthetic-consent",
        state,
        challenge,
        expiresAtMilliseconds: 600000,
        httpClient: HttpClient.make((request) => {
          urls.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ ...discovery, ...changed }))
          );
        }),
      }).pipe(Effect.exit);
      assert.deepStrictEqual(result, Exit.fail(new BancolombiaAuthorizationFailed()));
      expect(urls).toEqual([`${issuer}/.well-known/openid-configuration`]);
    }
  })
);

it.effect("does not retry uncertain or malformed PAR outcomes or expose provider bodies", () =>
  Effect.gen(function* () {
    const keys = yield* signing;
    for (const returned of [
      { status: 302, body: { error: "synthetic-secret" } },
      { status: 500, body: { error: "synthetic-secret" } },
      {
        status: 200,
        body: { request_uri: "urn:ietf:params:oauth:request_uri:synthetic", expires_in: 90 },
      },
      { status: 201, body: { request_uri: "https://foreign.example/secret", expires_in: 90 } },
      {
        status: 201,
        body: { request_uri: "urn:ietf:params:oauth:request_uri:synthetic", expires_in: 0 },
      },
      {
        status: 201,
        body: { request_uri: "urn:ietf:params:oauth:request_uri:synthetic", expires_in: 36000 },
      },
    ]) {
      let calls = 0;
      const result = yield* pushBancolombiaSandboxAuthorization({
        ...keys,
        clientId,
        consentId: "synthetic-consent",
        state,
        challenge,
        expiresAtMilliseconds: 600000,
        httpClient: HttpClient.make((request) => {
          calls += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.method === "GET"
                ? Response.json(discovery)
                : Response.json(returned.body, {
                    status: returned.status,
                    headers: { location: "https://foreign.example/par" },
                  })
            )
          );
        }),
      }).pipe(Effect.exit);
      assert.deepStrictEqual(result, Exit.fail(new BancolombiaAuthorizationFailed()));
      expect(calls).toBe(2);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result)
      ).not.toContain("synthetic-secret");
    }
  })
);

const assertionIdentifier = (
  jwt: string,
  key: CryptoKey
): Effect.Effect<string, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    jwtVerify(jwt, key, {
      algorithms: ["RS256"],
      issuer: clientId,
      subject: clientId,
      audience: issuer,
      currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
    })
  ).pipe(Effect.map((value) => value.payload.jti ?? ""));

const syntheticProfile = Schema.decodeSync(BancolombiaConsentProfile)({
  contract: "869a3da43fed9043b734e9be698e49234738cb3b1a26ca79cde3f606eb3fcd62",
  userId: clientId,
  admission: { startsAt: "1970-01-01T00:00:00.000Z", expiresAt: "1970-01-01T00:10:00.000Z" },
  financialId: "synthetic-participant",
  accountOwner: {
    Name: "Cliente de prueba",
    SchemeName: "CC",
    Identification: "synthetic-identity",
  },
  onBehalfOf: {
    TradingName: "Prueba",
    LegalName: "Prueba SAS",
    IdentifierType: "Other",
    Identifier: "synthetic-company",
  },
  customerIpAddress: "127.0.0.1",
  intent: {
    permissions: [
      "ReadAccountBasic",
      "ReadAccountDetail",
      "ReadBalance",
      "ReadTransactionBasic",
      "ReadTransactionDetail",
    ],
    historyFrom: "1969-12-31T00:00:00.000Z",
    historyTo: "1970-01-01T00:00:00.000Z",
    expiryPolicy: "bank-default",
  },
});
const consentResponse = {
  Data: {
    ConsentId: "synthetic-consent",
    Status: "AwaitingAuthorization",
    Permissions: syntheticProfile.intent.permissions,

    TransactionFromDateTime: DateTime.formatIso(syntheticProfile.intent.historyFrom),
    TransactionToDateTime: DateTime.formatIso(syntheticProfile.intent.historyTo),
  },
};
const createdConsentEndpoint =
  "https://rs1-api-open-finance-sandbox.ambientesbc.com/open-banking/v1/deposits/accounts/account-access-consent";
const returnedPermissions = (mode: string): readonly string[] => {
  if (mode === "mismatch") return ["ReadAccountBasic"];
  if (mode === "duplicate") return ["ReadAccountBasic", "ReadAccountBasic", "ReadAccountBasic"];
  return consentResponse.Data.Permissions;
};
it.effect(
  "creates and durably records the exact consent before PAR, refuses uncertainty and mismatched intent",
  () =>
    Effect.gen(function* () {
      const keys = yield* signing;
      for (const mode of [
        "ready",
        "minimal",
        "uncertain",
        "mismatch",
        "duplicate",
        "record-failure",
      ] as const) {
        const urls: string[] = [];
        const recorded: string[] = [];
        const assertions: string[] = [];
        const httpClient = HttpClient.make((request) =>
          Effect.gen(function* () {
            urls.push(request.url);
            if (request.method === "GET") {
              return HttpClientResponse.fromWeb(request, Response.json(discovery));
            }
            if (request.body._tag !== "Uint8Array") throw new Error("Expected encoded body");
            if (request.url === createdConsentEndpoint) {
              expect(request.headers.authorization).toBe("Bearer synthetic-bearer");
              expect(request.headers["x-fapi-financial-id"]).toBe(syntheticProfile.financialId);
              expect(request.headers["x-fapi-interaction-id"]).toMatch(/^[0-9a-f-]{36}$/u);
              expect(
                yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
                  new TextDecoder().decode(request.body.body)
                )
              ).toEqual({
                Data: {
                  Permissions: syntheticProfile.intent.permissions,

                  TransactionFromDateTime: consentResponse.Data.TransactionFromDateTime,
                  TransactionToDateTime: consentResponse.Data.TransactionToDateTime,
                  AccountOwner: syntheticProfile.accountOwner,
                  OnBehalfOf: syntheticProfile.onBehalfOf,
                },
              });
              return HttpClientResponse.fromWeb(
                request,
                Response.json(
                  mode === "minimal"
                    ? { Data: { ConsentId: "synthetic-consent" } }
                    : {
                        Data: {
                          ...consentResponse.Data,
                          Permissions: returnedPermissions(mode),
                        },
                      },
                  { status: mode === "uncertain" ? 503 : 200 }
                )
              );
            }
            const form = new URLSearchParams(new TextDecoder().decode(request.body.body));
            assertions.push(
              yield* assertionIdentifier(form.get("client_assertion") ?? "", keys.key.publicKey)
            );
            if (request.url.endsWith("/token")) {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  access_token: "synthetic-bearer",
                  token_type: "Bearer",
                  expires_in: 300,
                  scope: "accounts",
                })
              );
            }
            expect(recorded).toEqual(["synthetic-consent"]);
            yield* checkPar(request, keys.key.publicKey);
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                {
                  request_uri: "urn:ietf:params:oauth:request_uri:synthetic",
                  expires_in: 90,
                },
                { status: 201 }
              )
            );
          }).pipe(Effect.orDie)
        );
        const result = yield* authorizeBancolombiaSandbox({
          ...keys,
          clientId,
          httpClient,
          state,
          challenge,
          expiresAtMilliseconds: 600000,
          profile: Redacted.make(syntheticProfile),
          recordConsent: (consentId) => {
            recorded.push(consentId);
            return mode === "record-failure"
              ? Effect.fail(new BancolombiaAuthorizationFailed())
              : Effect.void;
          },
        }).pipe(Effect.exit);
        if (mode === "ready" || mode === "minimal") {
          expect(Exit.isSuccess(result)).toBe(true);
          expect(urls).toEqual([
            `${issuer}/.well-known/openid-configuration`,
            `${as}/token`,
            createdConsentEndpoint,
            `${issuer}/.well-known/openid-configuration`,
            `${as}/par`,
          ]);
          expect(new Set(assertions).size).toBe(2);
        } else {
          assert.deepStrictEqual(result, Exit.fail(new BancolombiaAuthorizationFailed()));
          expect(urls).toEqual([
            `${issuer}/.well-known/openid-configuration`,
            `${as}/token`,
            createdConsentEndpoint,
          ]);
        }
      }
    })
);
