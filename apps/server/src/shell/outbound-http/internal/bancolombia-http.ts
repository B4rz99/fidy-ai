import { Effect, Option, Redacted } from "effect";
import { FetchHttpClient, HttpBody, type HttpClient, HttpClientRequest } from "effect/http";
import type { BancolombiaSandboxHttpService } from "~/shell/outbound-http/contract";
import { makeProviderTransport } from "./transport";

const issuer = "https://auth1-api-open-finance-sandbox.ambientesbc.com";
const token = "https://as1-api-open-finance-sandbox.ambientesbc.com/token";
const maximumBytes = 65536;
const par = "https://as1-api-open-finance-sandbox.ambientesbc.com/par";

type BankRequest = Parameters<BancolombiaSandboxHttpService["execute"]>[0];
type ActivationRequest = Extract<
  BankRequest,
  {
    _tag: "BankSigningKeys" | "ExchangeBankCode" | "ReadBankConsent" | "ReadBankAccounts";
  }
>;
const isActivationRequest = (request: BankRequest): request is ActivationRequest =>
  request._tag === "BankSigningKeys" ||
  request._tag === "ExchangeBankCode" ||
  request._tag === "ReadBankConsent" ||
  request._tag === "ReadBankAccounts";
const prepareActivationRequest = (
  request: ActivationRequest
): HttpClientRequest.HttpClientRequest => {
  switch (request._tag) {
    case "BankSigningKeys":
      return HttpClientRequest.get(
        "https://s3.us-east-1.amazonaws.com/keystore.sandbox.bancol.col-hub-prod.ozoneapi.co.uk/server"
      );
    case "ExchangeBankCode":
      return HttpClientRequest.post(token, {
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
    case "ReadBankConsent":
      return HttpClientRequest.get(
        `https://rs1-api-open-finance-sandbox.ambientesbc.com/open-banking/v1/deposits/accounts/account-access-consent/${encodeURIComponent(request.consentId)}`,
        {
          headers: {
            authorization: `Bearer ${Redacted.value(request.bearer)}`,
            "x-fapi-financial-id": "",
            "x-fapi-interaction-id": request.interactionId,
          },
        }
      );
    case "ReadBankAccounts":
      return HttpClientRequest.get(
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
  }
};
type TokenRequest = Extract<BankRequest, { _tag: "RevokeBankToken" | "InspectBankToken" }>;
const isTokenRequest = (request: BankRequest): request is TokenRequest =>
  request._tag === "RevokeBankToken" || request._tag === "InspectBankToken";
const prepareTokenRequest = (request: TokenRequest): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.post(
    request._tag === "RevokeBankToken"
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
const prepareRequest = (request: BankRequest): HttpClientRequest.HttpClientRequest => {
  if (isTokenRequest(request)) return prepareTokenRequest(request);
  if (isActivationRequest(request)) return prepareActivationRequest(request);
  switch (request._tag) {
    case "Discovery":
      return HttpClientRequest.get(`${issuer}/.well-known/openid-configuration`);
    case "Authenticate":
      return HttpClientRequest.post(token, {
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
    case "CreateConsent":
      return HttpClientRequest.post(
        "https://rs1-api-open-finance-sandbox.ambientesbc.com/open-banking/v1/deposits/accounts/account-access-consent",
        {
          body: HttpBody.text(Redacted.value(request.payload), "application/json"),
          headers: {
            authorization: `Bearer ${Redacted.value(request.bearer)}`,
            "x-fapi-financial-id": request.financialId,
            "x-fapi-interaction-id": request.interactionId,
            ...(Option.isNone(request.customerIpAddress)
              ? {}
              : { "x-fapi-customer-ip-address": request.customerIpAddress.value }),
          },
        }
      );
    case "PushAuthorization":
      return HttpClientRequest.post(par, {
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
  }
};

export const bancolombiaSandboxHttp = (
  client: HttpClient.HttpClient
): BancolombiaSandboxHttpService => {
  const http = makeProviderTransport("bancolombia")(client);
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
