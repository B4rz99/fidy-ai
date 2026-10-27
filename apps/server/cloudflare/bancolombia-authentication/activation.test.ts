import { expect, it } from "@effect/vitest";
import { Context, Crypto, Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SignJWT, exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { TestCrypto } from "../../src/shell/testing/crypto-harness";
import { activateBancolombiaSandbox } from "./operations";

const issuer = "https://auth1-api-open-finance-sandbox.ambientesbc.com";
const as = "https://as1-api-open-finance-sandbox.ambientesbc.com";
const rs = "https://rs1-api-open-finance-sandbox.ambientesbc.com";
const jwks =
  "https://s3.us-east-1.amazonaws.com/keystore.sandbox.bancol.col-hub-prod.ozoneapi.co.uk/server";
const clientId = "10000000-0000-4000-8000-000000000001";

it.effect(
  "exchanges the claimed code with its original verifier, validates bank identity and retains authority before complete Account discovery",
  () =>
    Effect.gen(function* () {
      const crypto = Context.get(yield* Layer.build(TestCrypto), Crypto.Crypto);
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
        Effect.sync(() => {
          let body: unknown;
          if (request.url.endsWith("/.well-known/openid-configuration")) {
            body = {
              issuer,
              token_endpoint: `${as}/token`,
              jwks_uri: jwks,
              token_endpoint_auth_methods_supported: ["private_key_jwt"],
              token_endpoint_auth_signing_alg_values_supported: ["RS256"],
              tls_client_certificate_bound_access_tokens: true,
              mtls_endpoint_aliases: { token_endpoint: `${as}/token` },
            };
          } else if (request.url === jwks) {
            expect(request.headers.authorization).toBeUndefined();
            body = { keys: [bankKey] };
          } else if (request.url === `${as}/token`) {
            if (request.body._tag !== "Uint8Array") throw new Error("Expected encoded form");
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
            body = {
              access_token: "synthetic-access",
              refresh_token: "synthetic-refresh",
              expires_in: 300,
              token_type: "Bearer",
              scope: "accounts",
              id_token: idToken,
            };
          } else if (
            request.url ===
            `${rs}/open-banking/v1/deposits/accounts/account-access-consent/synthetic-consent`
          ) {
            body = {
              Data: {
                ConsentId: "synthetic-consent",
                Status: "Authorised",
                Permissions: ["ReadAccountsBasic"],
              },
            };
          } else {
            expect(retained).toBe(true);
            expect(request.url).toBe(`${rs}/open-banking/v1/deposits/accounts`);
            expect(request.headers.authorization).toBe("Bearer synthetic-access");
            body = {
              Data: {
                AccountReport: [
                  { AccountIdentification: "synthetic-account-a" },
                  { AccountIdentification: "synthetic-account-b" },
                ],
              },
            };
          }
          return HttpClientResponse.fromWeb(request, Response.json(body));
        })
      );
      const accounts = yield* activateBancolombiaSandbox({
        crypto,
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
            expect(Redacted.value(grant.accessToken)).toBe("synthetic-access");
            expect(Option.isSome(grant.refreshToken)).toBe(true);
            retained = true;
          }),
      });
      expect(accounts).toEqual(["synthetic-account-a", "synthetic-account-b"]);
    })
);
