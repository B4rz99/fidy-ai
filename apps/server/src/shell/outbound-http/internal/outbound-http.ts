import { type Crypto, Effect, Encoding, Option, Redacted } from "effect";
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
  type WompiTransactionBody,
} from "~/shell/outbound-http/contract";

const kapsoMessagesBaseUrl = "https://api.kapso.ai/meta/whatsapp/v24.0";
const wompiSandboxOrigin = "https://sandbox.wompi.co";
const wompiProductionOrigin = "https://production.wompi.co";
const bytesPerKibibyte = 1_024;
const maximumKapsoResponseKibibytes = 64;
const maximumWompiResponseKibibytes = 16;
const maximumKapsoResponseBytes = maximumKapsoResponseKibibytes * bytesPerKibibyte;
const maximumWompiResponseBytes = maximumWompiResponseKibibytes * bytesPerKibibyte;

type WompiTransportConfig = Readonly<{
  environment: "sandbox" | "production";
  publicKey: string;
  privateKey: Redacted.Redacted<string>;
  integritySecret: Redacted.Redacted<string>;
}>;

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

const unavailableTransport = (): OutboundHttpFailure =>
  new OutboundHttpFailure({
    reason: "transport-failed",
    responseStatus: Option.none(),
    responseHeaders: {},
  });

const makeKapsoRequest = (
  request: Extract<OutboundHttpRequest, { readonly _tag: "KapsoMessages" }>,
  apiKey: Redacted.Redacted<string>
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.post(
    `${kapsoMessagesBaseUrl}/${encodeURIComponent(request.businessPhoneNumberId)}/messages`
  ).pipe(
    HttpClientRequest.setHeaders({
      "content-type": "application/json",
      "x-api-key": Redacted.value(apiKey),
    }),
    HttpClientRequest.setBody(HttpBody.text(request.body, "application/json"))
  );

const transactionSignature = (
  crypto: Crypto.Crypto,
  integritySecret: Redacted.Redacted<string>,
  body: WompiTransactionBody
): Effect.Effect<string, OutboundHttpFailure> =>
  crypto
    .digest(
      "SHA-256",
      new TextEncoder().encode(
        `${body.reference}${body.amountInCents}${body.currency}${Redacted.value(integritySecret)}`
      )
    )
    .pipe(Effect.map(Encoding.encodeHex), Effect.mapError(unavailableTransport));

const makeWompiRequest = (
  request: Exclude<OutboundHttpRequest, { readonly _tag: "KapsoMessages" }>,
  config: WompiTransportConfig,
  crypto: Crypto.Crypto
): Effect.Effect<HttpClientRequest.HttpClientRequest, OutboundHttpFailure> => {
  const origin = config.environment === "sandbox" ? wompiSandboxOrigin : wompiProductionOrigin;
  const authorization = `Bearer ${Redacted.value(config.privateKey)}`;
  switch (request._tag) {
    case "WompiMerchant":
      return Effect.succeed(
        HttpClientRequest.get(`${origin}/v1/merchants/${encodeURIComponent(config.publicKey)}`)
      );
    case "WompiCreatePaymentSource":
      return Effect.succeed(
        HttpClientRequest.post(`${origin}/v1/payment_sources`, {
          headers: { authorization, "content-type": "application/json" },
          body: HttpBody.text(request.body, "application/json"),
        })
      );
    case "WompiVerifyPaymentSource":
      return Effect.succeed(
        HttpClientRequest.get(
          `${origin}/v1/payment_sources/${encodeURIComponent(request.sourceId)}`,
          { headers: { authorization } }
        )
      );
    case "WompiCreateTransaction":
      return transactionSignature(crypto, config.integritySecret, request.body).pipe(
        Effect.map((signature) =>
          HttpClientRequest.post(`${origin}/v1/transactions`, {
            headers: { authorization, "content-type": "application/json" },
            body: HttpBody.text(
              JSON.stringify({
                amount_in_cents: request.body.amountInCents,
                currency: request.body.currency,
                customer_email: request.body.billingEmail,
                payment_method: { installments: 1 },
                payment_source_id: request.body.sourceId,
                reference: request.body.reference,
                signature,
              }),
              "application/json"
            ),
          })
        )
      );
    case "WompiFindTransaction":
      return Effect.succeed(
        HttpClientRequest.get(
          `${origin}/v1/transactions/${encodeURIComponent(request.transactionId)}`,
          { headers: { authorization } }
        )
      );
  }
};

/**
 * Creates fixed-destination provider transport that owns credentials, rejects redirects, suppresses
 * trace propagation, bounds response bytes, and returns only retained response facts or closed
 * failures.
 */
export const makeOutboundHttp = ({
  kapsoApiKey,
  wompi,
  httpClient,
  crypto,
}: Readonly<{
  kapsoApiKey: Redacted.Redacted<string>;
  wompi: WompiTransportConfig;
  httpClient: HttpClient.HttpClient;
  crypto: Crypto.Crypto;
}>): PrivateOutboundHttpService => {
  const kapsoHttp = makeBoundedExternalHttpClient("kapso")(httpClient);
  const wompiHttp = makeBoundedExternalHttpClient("wompi")(httpClient);
  return {
    execute: (request) => {
      const prepared =
        request._tag === "KapsoMessages"
          ? Effect.succeed({
              http: kapsoHttp,
              maximumResponseBytes: maximumKapsoResponseBytes,
              request: makeKapsoRequest(request, kapsoApiKey),
            })
          : makeWompiRequest(request, wompi, crypto).pipe(
              Effect.map((wompiRequest) => ({
                http: wompiHttp,
                maximumResponseBytes: maximumWompiResponseBytes,
                request: wompiRequest,
              }))
            );
      return prepared.pipe(
        Effect.flatMap(({ http, maximumResponseBytes, request: providerRequest }) =>
          http.execute(providerRequest, maximumResponseBytes)
        ),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.map((response) => ({
          status: response.status,
          headers: { ...response.headers },
          body: response.body,
        })),
        Effect.mapError((failure) =>
          failure._tag === "OutboundHttpFailure" ? failure : projectFailure(failure)
        )
      );
    },
  };
};
