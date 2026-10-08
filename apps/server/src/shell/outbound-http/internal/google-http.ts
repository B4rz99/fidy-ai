import { Effect, Redacted } from "effect";
import { FetchHttpClient, HttpBody, type HttpClient, HttpClientRequest } from "effect/http";
import { makeProviderTransport } from "./transport";
import type { GoogleHttpService } from "~/shell/outbound-http/contract";

const maximumResponseBytes = 32768;
/** Only the reviewed Google endpoints are reachable; protocol credentials remain in POST bodies. */
export const googleHttp = (
  input: Readonly<{
    clientId: string;
    clientSecret: Redacted.Redacted<string>;
    redirectUri: string;
    httpClient: HttpClient.HttpClient;
  }>
): GoogleHttpService => {
  const http = makeProviderTransport("google")(input.httpClient);
  return {
    execute: (request) => {
      const prepared =
        request._tag === "SigningKeys"
          ? HttpClientRequest.get("https://www.googleapis.com/oauth2/v3/certs")
          : HttpClientRequest.post("https://oauth2.googleapis.com/token", {
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
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.timeout("5 seconds")
        );
    },
  };
};
