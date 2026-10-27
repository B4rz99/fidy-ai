import { UserId } from "../src/core/identity/contract";
import { activationFixture } from "./bancolombia-activation.test-fixture";
import { BancolombiaAuthorizationFailed } from "./bancolombia-authentication/contract";
import { DateTime, Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { InstitutionId } from "../src/core/connections/contract";
import { authorizeBancolombiaSandbox } from "./bancolombia-authentication/operations";
import {
  ConnectionAuthorizationUnavailable,
  type ConnectionBankActivation,
  type ConnectionBankPreparation,
  type ConnectionConsentIntent,
} from "./connections/contract";

const issuer = "https://auth1-api-open-finance-sandbox.ambientesbc.com";
const as = "https://as1-api-open-finance-sandbox.ambientesbc.com";
const activationBank = await Effect.runPromise(activationFixture);
const keys = activationBank.credentials;
const Scenario = Schema.Literals([
  "ready",
  "destination",
  "signing",
  "transport",
  "activation-malformed",
]);

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
const fixtureIntent = (): ConnectionConsentIntent => ({
  permissions: [
    "ReadAccountsBasic",
    "ReadTransactionsCredits",
    "ReadBalances",
    "ReadTransactionsDebits",
    "ReadTransactionsDetail",
  ],
  historyPolicy: "bank-default",
  expiryPolicy: "bank-default",
});

const prepareBank = (
  input: Readonly<{
    userId: string;
    scenario: typeof Scenario.Type;
    intent: ConnectionConsentIntent;
    request: Parameters<ConnectionBankPreparation["prepare"]>[0];
  }>
): ReturnType<ConnectionBankPreparation["prepare"]> => {
  const { userId, scenario, intent, request } = input;
  return request.userId !== userId
    ? Effect.fail(new ConnectionAuthorizationUnavailable())
    : authorizeBancolombiaSandbox({
        ...keys,
        ...request,
        profile: Redacted.make({
          contract: "bancolombia-sandbox-consent-2026-10-27",
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
          request
            .recordConsent(consentId)
            .pipe(Effect.mapError(() => new BancolombiaAuthorizationFailed())),
        clientId: "10000000-0000-4000-8000-000000000001",
        privateKey:
          scenario === "signing" ? Redacted.make("invalid-synthetic-key") : keys.privateKey,
        httpClient: fixtureClient(scenario, intent),
      }).pipe(Effect.mapError(() => new ConnectionAuthorizationUnavailable()));
};

export const makeConnectionFixture = (
  userId: string
): Readonly<{
  institutions: InstitutionId[];
  bank: ConnectionBankPreparation;
  activation: ConnectionBankActivation;
  operator: (request: Request) => Option.Option<Promise<Response>>;
}> => {
  const institutions: InstitutionId[] = [];
  let scenario: typeof Scenario.Type = "ready";
  let state = "";
  const intent = fixtureIntent();
  const bank: ConnectionBankPreparation = {
    intent,
    prepare: (input) => {
      state = input.state;
      return prepareBank({ userId, scenario, intent, request: input });
    },
  };
  return {
    institutions,
    bank,
    activation: activationBank.activation,
    operator: (request) => {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === "/connections/bank-return"
      ) {
        return Option.some(Promise.resolve(Response.json({ state })));
      }
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
      activationBank.scenario(scenario === "activation-malformed" ? "malformed" : "ready");
      if (institutions.length === 0) institutions.push(InstitutionId.make("bancolombia"));
      return Option.some(Promise.resolve(new Response(null, { status: 204 })));
    },
  };
};
