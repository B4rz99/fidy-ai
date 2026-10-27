import { Effect, Option, Redacted } from "effect";
import { FetchHttpClient, HttpBody, type HttpClient, HttpClientRequest } from "effect/http";
import type { BancolombiaSandboxHttpService } from "~/shell/outbound-http/contract";
import { makeProviderTransport } from "./transport";

const issuer = "https://auth1-api-open-finance-sandbox.ambientesbc.com";
const token = "https://as1-api-open-finance-sandbox.ambientesbc.com/token";
const maximumBytes = 65536;
const par = "https://as1-api-open-finance-sandbox.ambientesbc.com/par";

const prepareRequest = (
  request: Parameters<BancolombiaSandboxHttpService["execute"]>[0]
): HttpClientRequest.HttpClientRequest => {
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
