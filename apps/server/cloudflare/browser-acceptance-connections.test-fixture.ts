import { UserId } from "../src/core/identity/contract";
import { BancolombiaAuthorizationFailed } from "./bancolombia-authentication/contract";
import { Context, Crypto, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { TestCrypto } from "../src/shell/testing/crypto-harness";
import { InstitutionId } from "../src/core/connections/contract";
import { authorizeBancolombiaSandbox } from "./bancolombia-authentication/operations";
import {
  ConnectionAuthorizationUnavailable,
  type ConnectionBankPreparation,
  type ConnectionConsentIntent,
} from "./connections/contract";

const issuer = "https://auth1-api-open-finance-sandbox.ambientesbc.com";
const as = "https://as1-api-open-finance-sandbox.ambientesbc.com";
const keys = await Effect.runPromise(
  Effect.gen(function* () {
    const crypto = Context.get(yield* Layer.build(TestCrypto), Crypto.Crypto);
    const key = yield* Effect.tryPromise(() => generateKeyPair("RS256", { extractable: true }));
    return {
      crypto,
      privateKey: Redacted.make(yield* Effect.tryPromise(() => exportPKCS8(key.privateKey))),
      publicKey: {
        ...(yield* Effect.tryPromise(() => exportJWK(key.publicKey))),
        kid: "synthetic-authorization-key",
        alg: "RS256",
      },
    };
  }).pipe(Effect.scoped)
);
const Scenario = Schema.Literals(["ready", "destination", "signing", "transport"]);

const fixtureAdmissionExpiry = 600000;
const createdStatus = 201;
const unavailableStatus = 503;
const fixtureResponse = (
  input: Readonly<{ scenario: typeof Scenario.Type; intent: ConnectionConsentIntent; url: string }>
): Response => {
  if (input.url.endsWith("/.well-known/openid-configuration")) {
    return Response.json({
      issuer,
      token_endpoint: `${as}/token`,
      authorization_endpoint: `${issuer}/auth`,
      pushed_authorization_request_endpoint:
        input.scenario === "destination" ? "https://foreign.example/par" : `${as}/par`,
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      tls_client_certificate_bound_access_tokens: true,
      mtls_endpoint_aliases: {
        token_endpoint: `${as}/token`,
        pushed_authorization_request_endpoint: `${as}/par`,
      },
    });
  }
  if (input.url.endsWith("/token")) {
    return Response.json({
      access_token: "synthetic-bearer",
      token_type: "Bearer",
      expires_in: 300,
      scope: "accounts",
    });
  }
  if (input.url.endsWith("/account-access-consent")) {
    return Response.json({
      Data: {
        ConsentId: "synthetic-consent",
        Status: "AwaitingAuthorization",
        Permissions: input.intent.permissions,

        TransactionFromDateTime: DateTime.formatIso(input.intent.historyFrom),
        TransactionToDateTime: DateTime.formatIso(input.intent.historyTo),
      },
    });
  }
  return Response.json(
    { request_uri: "urn:ietf:params:oauth:request_uri:synthetic", expires_in: 90 },
    { status: input.scenario === "transport" ? unavailableStatus : createdStatus }
  );
};
const fixtureClient = (
  scenario: typeof Scenario.Type,
  intent: ConnectionConsentIntent
): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, fixtureResponse({ scenario, intent, url: request.url }))
    )
  );
const fixtureHistoryDays = 90;
const millisecondsPerDay = 86400000;
const fixtureHistoryMilliseconds = fixtureHistoryDays * millisecondsPerDay;

const fixtureIntent = (): ConnectionConsentIntent => ({
  permissions: [
    "ReadAccountBasic",
    "ReadAccountDetail",
    "ReadBalance",
    "ReadTransactionBasic",
    "ReadTransactionDetail",
  ],
  historyFrom: DateTime.makeUnsafe(
    DateTime.nowUnsafe().epochMilliseconds - fixtureHistoryMilliseconds
  ),
  historyTo: DateTime.nowUnsafe(),
  expiryPolicy: "bank-default",
});

export const makeConnectionFixture = (
  userId: string
): Readonly<{
  institutions: InstitutionId[];
  bank: ConnectionBankPreparation;
  operator: (request: Request) => Option.Option<Promise<Response>>;
}> => {
  const institutions: InstitutionId[] = [];
  let scenario: typeof Scenario.Type = "ready";
  const intent = fixtureIntent();
  const bank: ConnectionBankPreparation = {
    intent,
    prepare: (input) =>
      input.userId !== userId
        ? Effect.fail(new ConnectionAuthorizationUnavailable())
        : authorizeBancolombiaSandbox({
            ...keys,
            ...input,
            profile: Redacted.make({
              contract: "869a3da43fed9043b734e9be698e49234738cb3b1a26ca79cde3f606eb3fcd62",
              userId: Schema.decodeSync(UserId)(userId),
              admission: {
                startsAt: DateTime.makeUnsafe(0),
                expiresAt: DateTime.makeUnsafe(fixtureAdmissionExpiry),
              },
              financialId: "synthetic-financial-id",
              accountOwner: { SchemeName: "CC", Identification: "synthetic-identity" },
              intent,
            }),
            recordConsent: (consentId) =>
              input
                .recordConsent(consentId)
                .pipe(Effect.mapError(() => new BancolombiaAuthorizationFailed())),
            clientId: "10000000-0000-4000-8000-000000000001",
            privateKey:
              scenario === "signing" ? Redacted.make("invalid-synthetic-key") : keys.privateKey,
            httpClient: fixtureClient(scenario, intent),
          }).pipe(Effect.mapError(() => new ConnectionAuthorizationUnavailable())),
  };
  return {
    institutions,
    bank,
    operator: (request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/connections/scenario") {
        return Option.none();
      }
      const parsed = Schema.decodeUnknownOption(Scenario)(
        new URL(request.url).searchParams.get("mode")
      );
      if (Option.isNone(parsed)) {
        return Option.some(Promise.resolve(new Response(null, { status: 400 })));
      }
      scenario = parsed.value;
      if (institutions.length === 0) institutions.push(InstitutionId.make("bancolombia"));
      return Option.some(Promise.resolve(new Response(null, { status: 204 })));
    },
  };
};
