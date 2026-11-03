import { Effect, Redacted } from "effect";
import { FetchHttpClient, HttpBody, type HttpClient, HttpClientRequest } from "effect/http";
import type { OpenAiHttpService } from "~/shell/outbound-http/contract";
import { makeProviderTransport } from "./transport";

const maximumResponseBytes = 524_288;

export const openAiHttp = ({
  apiKey,
  client,
}: Readonly<{
  apiKey: Redacted.Redacted<string>;
  client: HttpClient.HttpClient;
}>): OpenAiHttpService => {
  const http = makeProviderTransport("openai")(client);
  return {
    execute: (body) =>
      http
        .execute(
          HttpClientRequest.post("https://api.openai.com/v1/chat/completions", {
            headers: {
              authorization: `Bearer ${Redacted.value(apiKey)}`,
              "content-type": "application/json",
            },
            body: HttpBody.text(body, "application/json"),
          }),
          maximumResponseBytes
        )
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            credentials: "omit",
            redirect: "manual",
          })
        ),
  };
};
