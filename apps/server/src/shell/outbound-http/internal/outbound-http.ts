import { Effect, Redacted } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  type HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import {
  type ExternalHttpFailure,
  makeBoundedExternalHttpClient,
} from "~/shell/_shared/bounded-external-http";
import {
  OutboundHttpFailure,
  type OutboundHttpRequest,
  type OutboundHttpResponse,
} from "~/shell/outbound-http/contract";

const kapsoMessagesBaseUrl = "https://api.kapso.ai/meta/whatsapp/v24.0";
const bytesPerKibibyte = 1_024;
const maximumKapsoResponseKibibytes = 64;
const maximumKapsoResponseBytes = maximumKapsoResponseKibibytes * bytesPerKibibyte;

type PrivateOutboundHttpService = Readonly<{
  execute: (
    request: OutboundHttpRequest
  ) => Effect.Effect<OutboundHttpResponse, OutboundHttpFailure>;
}>;

const projectFailure = (failure: ExternalHttpFailure): OutboundHttpFailure =>
  new OutboundHttpFailure({
    reason: failure.reason,
    responseStatus: failure.responseStatus,
    responseHeaders: { ...failure.responseHeaders },
  });

const makeKapsoRequest = (
  request: OutboundHttpRequest,
  apiKey: Redacted.Redacted<string>
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.post(
    `${kapsoMessagesBaseUrl}/${encodeURIComponent(request.destination.businessPhoneNumberId)}/messages`
  ).pipe(
    HttpClientRequest.setHeaders({
      "content-type": "application/json",
      "x-api-key": Redacted.value(apiKey),
    }),
    HttpClientRequest.setBody(HttpBody.text(request.body, "application/json"))
  );

/**
 * Creates fixed-origin Kapso transport that owns its credential, rejects redirects, suppresses trace
 * propagation, bounds response bytes, and returns only retained response facts or closed failures.
 */
export const makeOutboundHttp = ({
  kapsoApiKey,
  httpClient,
}: Readonly<{
  kapsoApiKey: Redacted.Redacted<string>;
  httpClient: HttpClient.HttpClient;
}>): PrivateOutboundHttpService => {
  const boundedHttp = makeBoundedExternalHttpClient("kapso")(httpClient);
  return {
    execute: (
      request: OutboundHttpRequest
    ): Effect.Effect<OutboundHttpResponse, OutboundHttpFailure> =>
      boundedHttp.execute(makeKapsoRequest(request, kapsoApiKey), maximumKapsoResponseBytes).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.map((response) => ({
          status: response.status,
          headers: { ...response.headers },
          body: response.body,
        })),
        Effect.mapError(projectFailure)
      ),
  };
};
