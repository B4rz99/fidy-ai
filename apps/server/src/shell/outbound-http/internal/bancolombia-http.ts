import { Effect, Redacted } from "effect";
import { FetchHttpClient, HttpBody, type HttpClient, HttpClientRequest } from "effect/http";
import type { BancolombiaSandboxHttpService } from "~/shell/outbound-http/contract";
import { makeProviderTransport } from "./transport";

const issuer = "https://auth1-api-open-finance-sandbox.ambientesbc.com";
const token = "https://as1-api-open-finance-sandbox.ambientesbc.com/token";
const maximumBytes = 65536;

export const bancolombiaSandboxHttp = (
  client: HttpClient.HttpClient
): BancolombiaSandboxHttpService => {
  const http = makeProviderTransport("bancolombia")(client);
  return {
    execute: (request) => {
      const prepared =
        request._tag === "Discovery"
          ? HttpClientRequest.get(`${issuer}/.well-known/openid-configuration`)
          : HttpClientRequest.post(token, {
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
      return http.execute(prepared, maximumBytes).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
          credentials: "omit",
        }),
        Effect.timeout("10 seconds")
      );
    },
  };
};
