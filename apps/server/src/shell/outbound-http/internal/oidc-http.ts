import { Effect, Redacted } from "effect";
import { FetchHttpClient, HttpBody, type HttpClient, HttpClientRequest } from "effect/http";
import { makeProviderTransport } from "./transport";
import type { ProviderOidcHttpService } from "~/shell/outbound-http/contract";

const maximumResponseBytes = 32768;
const oidcDestinations = {
  google: {
    keys: "https://www.googleapis.com/oauth2/v3/certs",
    token: "https://oauth2.googleapis.com/token",
  },
  microsoft: {
    keys: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  },
} as const;
/** Only the selected provider’s reviewed endpoints are reachable; protocol credentials remain in POST bodies. */
export const oidcHttp = (
  input: Readonly<{
    provider: "google" | "microsoft";
    clientId: string;
    clientSecret: Redacted.Redacted<string>;
    redirectUri: string;
    httpClient: HttpClient.HttpClient;
  }>
): ProviderOidcHttpService => {
  const http = makeProviderTransport(input.provider)(input.httpClient);
  const destinations = oidcDestinations[input.provider];
  return {
    execute: (request) => {
      const prepared =
        request._tag === "SigningKeys"
          ? HttpClientRequest.get(destinations.keys)
          : HttpClientRequest.post(destinations.token, {
              body: HttpBody.text(
                new URLSearchParams({
                  grant_type: "authorization_code",
                  client_id: input.clientId,
                  client_secret: Redacted.value(input.clientSecret),
                  redirect_uri: input.redirectUri,
                  code: Redacted.value(request.code),
                  code_verifier: Redacted.value(request.verifier),
                }).toString(),
                "application/x-www-form-urlencoded"
              ),
            });
      return http
        .execute(prepared, maximumResponseBytes)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.timeout("5 seconds")
        );
    },
  };
};
