import { Digest, SecureRandom } from "effect/crypto";
import { assert, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Match, Option, Predicate, Redacted } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import { type JWK, SignJWT, exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { TestCrypto } from "../../src/shell/testing/crypto-harness";
import { activateBancolombiaSandbox } from "./operations";

const issuer = "https://auth1-api-open-finance-sandbox.ambientesbc.com";

const as = "https://as1-api-open-finance-sandbox.ambientesbc.com";

const rs = "https://rs1-api-open-finance-sandbox.ambientesbc.com";

const jwks =
  "https://s3.us-east-1.amazonaws.com/keystore.sandbox.bancol.col-hub-prod.ozoneapi.co.uk/server";

const clientId = "10000000-0000-4000-8000-000000000001";

type BankFixture = Readonly<{ bankKey: JWK; idToken: string; retained: boolean }>;

const tokenResponse = (
  request: HttpClientRequest.HttpClientRequest,
  idToken: string
): HttpClientResponse.HttpClientResponse => {
  assert(Predicate.isTagged(request.body, "Uint8Array"), "Expected encoded form");
  const form = new URLSearchParams(new TextDecoder().decode(request.body.body));

  if (form.get("grant_type") === "client_credentials") {
    return HttpClientResponse.fromWeb(
      request,
      Response.json({
        access_token: "synthetic-application",
        expires_in: 300,
        token_type: "Bearer",
        scope: "accounts",
      })
    );
  }

  expect(form.get("grant_type")).toBe("authorization_code");
  expect(form.get("scope")).toBe("accounts");
  expect(form.get("code")).toBe("synthetic-code");
  expect(form.get("code_verifier")).toBe("v".repeat(43));
  expect(form.get("redirect_uri")).toBe(
    "https://api.fidyapp.com/connections/bancolombia/sandbox/callback"
  );

  return HttpClientResponse.fromWeb(
    request,
    Response.json({
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      expires_in: 300,
      token_type: "Bearer",
      scope: "accounts",
      id_token: idToken,
    })
  );
};

const keysResponse = (
  request: HttpClientRequest.HttpClientRequest,
  bankKey: JWK
): HttpClientResponse.HttpClientResponse => {
  expect(request.headers.authorization).toBeUndefined();

  return HttpClientResponse.fromWeb(request, Response.json({ keys: [bankKey] }));
};

const accountsResponse = (
  request: HttpClientRequest.HttpClientRequest,
  retained: boolean
): HttpClientResponse.HttpClientResponse => {
  expect(retained).toBe(true);
  expect(request.url).toBe(`${rs}/open-banking/v1/deposits/accounts`);
  expect(request.headers.authorization).toBe("Bearer synthetic-access");

  return HttpClientResponse.fromWeb(
    request,
    Response.json({
      Data: {
        AccountReport: [
          { AccountIdentification: "synthetic-account-a" },
          { AccountIdentification: "synthetic-account-b" },
        ],
      },
    })
  );
};

const bankResponse = (
  request: HttpClientRequest.HttpClientRequest,
  fixture: BankFixture
): HttpClientResponse.HttpClientResponse =>
  Match.value(request.url).pipe(
    Match.when(
      (url) => url.endsWith("/.well-known/openid-configuration"),
      () =>
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            issuer,
            token_endpoint: `${as}/token`,
            jwks_uri: jwks,
            token_endpoint_auth_methods_supported: ["private_key_jwt"],
            token_endpoint_auth_signing_alg_values_supported: ["RS256"],
            tls_client_certificate_bound_access_tokens: true,
            mtls_endpoint_aliases: { token_endpoint: `${as}/token` },
          })
        )
    ),
    Match.when(jwks, () => keysResponse(request, fixture.bankKey)),
    Match.when(`${as}/token`, () => tokenResponse(request, fixture.idToken)),
    Match.when(
      `${rs}/open-banking/v1/deposits/accounts/account-access-consent/synthetic-consent`,
      () =>
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            Data: {
              ConsentId: "synthetic-consent",
              Status: "Authorised",
              Permissions: ["ReadAccountsBasic"],
            },
          })
        )
    ),
    Match.orElse(() => accountsResponse(request, fixture.retained))
  );

it.effect(
  "exchanges the claimed code with its original verifier, validates bank identity and retains authority before complete Account discovery",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(TestCrypto);
      const secureRandom = Context.get(services, SecureRandom.SecureRandom);
      const digest = Context.get(services, Digest.Digest);

      const client = yield* Effect.tryPromise(() =>
        generateKeyPair("RS256", { extractable: true })
      );

      const bank = yield* Effect.tryPromise(() => generateKeyPair("RS256", { extractable: true }));

      const publicKey = {
        ...(yield* Effect.tryPromise(() => exportJWK(client.publicKey))),
        kid: "client",
        alg: "RS256",
      };

      const bankKey = {
        ...(yield* Effect.tryPromise(() => exportJWK(bank.publicKey))),
        kid: "bank",
        alg: "RS256",
      };

      const idToken = yield* Effect.tryPromise(() =>
        new SignJWT({ openbanking_intent_id: "synthetic-consent" })
          .setProtectedHeader({ alg: "RS256", kid: "bank" })
          .setIssuer(issuer)
          .setAudience(clientId)
          .setSubject("synthetic-bank-user")
          .setIssuedAt(0)
          .setExpirationTime(300)
          .sign(bank.privateKey)
      );

      let retained = false;

      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => bankResponse(request, { bankKey, idToken, retained }))
      );

      const accounts = yield* activateBancolombiaSandbox({
        secureRandom,
        digest,
        clientId,
        publicKey,
        privateKey: Redacted.make(yield* Effect.tryPromise(() => exportPKCS8(client.privateKey))),
        httpClient,
        code: Redacted.make("synthetic-code"),
        verifier: Redacted.make("v".repeat(43)),
        consentId: "synthetic-consent",
        state: "s".repeat(43),
        intent: {
          permissions: ["ReadAccountsBasic"],
          historyPolicy: "bank-default",
          expiryPolicy: "bank-default",
        },
        expiresAtMilliseconds: 600000,
        retainGrant: (grant) =>
          Effect.sync(() => {
            expect(Option.map(grant.accessToken, Redacted.value)).toEqual(
              Option.some("synthetic-access")
            );
            expect(Option.isSome(grant.refreshToken)).toBe(true);
            retained = true;
          }),
      }).pipe(Effect.provideService(SecureRandom.SecureRandom, secureRandom));

      expect(accounts).toEqual(["synthetic-account-a", "synthetic-account-b"]);
    })
);
