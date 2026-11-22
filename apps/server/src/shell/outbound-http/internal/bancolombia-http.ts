import { type Data, Effect, Option, Redacted } from "effect";
import { FetchHttpClient, HttpBody, type HttpClient, HttpClientRequest } from "effect/http";
import {
  BancolombiaSandboxHttpRequest,
  type BancolombiaSandboxHttpService,
} from "~/shell/outbound-http/contract";
import { providerTransport } from "./transport";

const issuer = "https://auth1-api-open-finance-sandbox.ambientesbc.com";

const token = "https://as1-api-open-finance-sandbox.ambientesbc.com/token";

const maximumBytes = 65536;

const par = "https://as1-api-open-finance-sandbox.ambientesbc.com/par";

type Request<Tag extends BancolombiaSandboxHttpRequest["_tag"]> = Data.TaggedEnum.Value<
  BancolombiaSandboxHttpRequest,
  Tag
>;

type TokenRequest = Request<"RevokeBankToken" | "InspectBankToken">;

const prepareExchangeBankCode = (
  request: Request<"ExchangeBankCode">
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.post(token, {
    body: HttpBody.text(
      new URLSearchParams({
        grant_type: "authorization_code",
        scope: "accounts",
        code: Redacted.value(request.code),
        redirect_uri: "https://api.fidyapp.com/connections/bancolombia/sandbox/callback",
        code_verifier: Redacted.value(request.verifier),
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: Redacted.value(request.assertion),
      }).toString(),
      "application/x-www-form-urlencoded"
    ),
  });

const prepareReadBankConsent = (
  request: Request<"ReadBankConsent">
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.get(
    `https://rs1-api-open-finance-sandbox.ambientesbc.com/open-banking/v1/deposits/accounts/account-access-consent/${encodeURIComponent(request.consentId)}`,
    {
      headers: {
        authorization: `Bearer ${Redacted.value(request.bearer)}`,
        "x-fapi-financial-id": "",
        "x-fapi-interaction-id": request.interactionId,
      },
    }
  );

const prepareReadBankAccounts = (
  request: Request<"ReadBankAccounts">
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.get(
    "https://rs1-api-open-finance-sandbox.ambientesbc.com/open-banking/v1/deposits/accounts",
    {
      headers: {
        authorization: `Bearer ${Redacted.value(request.bearer)}`,
        "x-fapi-financial-id": "",
        "x-fapi-interaction-id": request.interactionId,
      },
      urlParams: Option.isSome(request.page) ? { pageNumber: String(request.page.value) } : {},
    }
  );

const prepareAuthenticate = (
  request: Request<"Authenticate">
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.post(token, {
    body: HttpBody.text(
      new URLSearchParams({
        grant_type: "client_credentials",
        scope: "accounts",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: Redacted.value(request.assertion),
      }).toString(),
      "application/x-www-form-urlencoded"
    ),
  });

const prepareCreateConsent = (
  request: Request<"CreateConsent">
): HttpClientRequest.HttpClientRequest => {
  const prepared = HttpClientRequest.post(
    "https://rs1-api-open-finance-sandbox.ambientesbc.com/open-banking/v1/deposits/accounts/account-access-consent",
    {
      body: HttpBody.text(Redacted.value(request.payload), "application/json"),
      headers: {
        authorization: `Bearer ${Redacted.value(request.bearer)}`,
        "x-fapi-financial-id": request.financialId,
        "x-fapi-interaction-id": request.interactionId,
      },
    }
  );

  return Option.match(request.customerIpAddress, {
    onNone: () => prepared,
    onSome: (address) =>
      HttpClientRequest.setHeader(prepared, "x-fapi-customer-ip-address", address),
  });
};

const preparePushAuthorization = (
  request: Request<"PushAuthorization">
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.post(par, {
    body: HttpBody.text(
      new URLSearchParams({
        client_id: request.clientId,
        redirect_uri: "https://api.fidyapp.com/connections/bancolombia/sandbox/callback",
        scope: `accounts:${request.consentId} openid`,
        state: request.state,
        response_type: "code",
        code_challenge: request.challenge,
        code_challenge_method: "S256",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: Redacted.value(request.assertion),
      }).toString(),
      "application/x-www-form-urlencoded"
    ),
  });

const prepareTokenRequest = (request: TokenRequest): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.post(
    BancolombiaSandboxHttpRequest.$is("RevokeBankToken")(request)
      ? "https://as1-api-open-finance-sandbox.ambientesbc.com/token/revoke"
      : "https://as1-api-open-finance-sandbox.ambientesbc.com/introspection",
    {
      body: HttpBody.text(
        new URLSearchParams({
          token: Redacted.value(request.token),
          token_type_hint: request.tokenType,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: Redacted.value(request.assertion),
        }).toString(),
        "application/x-www-form-urlencoded"
      ),
    }
  );

const prepareRequest = BancolombiaSandboxHttpRequest.$match({
  Discovery: (): HttpClientRequest.HttpClientRequest =>
    HttpClientRequest.get(`${issuer}/.well-known/openid-configuration`),
  Authenticate: prepareAuthenticate,
  RevokeBankToken: prepareTokenRequest,
  InspectBankToken: prepareTokenRequest,
  BankSigningKeys: (): HttpClientRequest.HttpClientRequest =>
    HttpClientRequest.get(
      "https://s3.us-east-1.amazonaws.com/keystore.sandbox.bancol.col-hub-prod.ozoneapi.co.uk/server"
    ),
  ExchangeBankCode: prepareExchangeBankCode,
  ReadBankConsent: prepareReadBankConsent,
  ReadBankAccounts: prepareReadBankAccounts,
  CreateConsent: prepareCreateConsent,
  PushAuthorization: preparePushAuthorization,
});

export const bancolombiaSandboxHttp = (
  client: HttpClient.HttpClient
): BancolombiaSandboxHttpService => {
  const http = providerTransport("bancolombia")(client);

  return {
    execute: (request) => {
      const prepared = prepareRequest(request);

      return http
        .execute(HttpClientRequest.setHeader(prepared, "accept", "application/json"), maximumBytes)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            credentials: "omit",
          }),
          Effect.timeout("10 seconds")
        );
    },
  };
};
