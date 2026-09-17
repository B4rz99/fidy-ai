import { type Crypto, Effect, Encoding, Option, Redacted, Result, Schema } from "effect";
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
const resendApiBaseUrl = "https://api.resend.com";
const wompiSandboxOrigin = "https://sandbox.wompi.co";
const wompiProductionOrigin = "https://production.wompi.co";
const bytesPerKibibyte = 1_024;
const maximumKapsoResponseKibibytes = 64;
const maximumWompiResponseKibibytes = 16;
const maximumResendDeliveryResponseKibibytes = 4;
const maximumResendMetadataResponseKibibytes = 1_024;
const maximumResendAttachmentResponseKibibytes = 4;
const maximumResendInlineImageResponseKibibytes = 1_024;
const maximumKapsoResponseBytes = maximumKapsoResponseKibibytes * bytesPerKibibyte;
const maximumWompiResponseBytes = maximumWompiResponseKibibytes * bytesPerKibibyte;
const maximumResendDeliveryResponseBytes =
  maximumResendDeliveryResponseKibibytes * bytesPerKibibyte;
const maximumResendMetadataResponseBytes =
  maximumResendMetadataResponseKibibytes * bytesPerKibibyte;
const maximumResendAttachmentResponseBytes =
  maximumResendAttachmentResponseKibibytes * bytesPerKibibyte;
const maximumResendInlineImageResponseBytes =
  maximumResendInlineImageResponseKibibytes * bytesPerKibibyte;

type PreparedRequest = Readonly<{
  http: ReturnType<ReturnType<typeof makeBoundedExternalHttpClient>>;
  request: HttpClientRequest.HttpClientRequest;
  maximumResponseBytes: number;
  redirect: "error" | "manual";
}>;

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

const resendAuthorization = (
  apiKey: Redacted.Redacted<string>
): Readonly<Record<string, string>> => ({ authorization: `Bearer ${Redacted.value(apiKey)}` });

const ResendInboundDownloadUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === "https:" &&
    url.hostname === "inbound-cdn.resend.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
      ? undefined
      : "Expected a direct Resend inbound CDN URL"
  )
);
const decodeResendInboundDownloadUrl = Schema.decodeUnknownResult(ResendInboundDownloadUrl);

const invalidDestination = (): OutboundHttpFailure =>
  new OutboundHttpFailure({
    reason: "invalid-destination",
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

type ResendRequest = Extract<OutboundHttpRequest, { readonly _tag: `Resend${string}` }>;
type WompiRequest = Extract<OutboundHttpRequest, { readonly _tag: `Wompi${string}` }>;

const makeResendRequest = (
  request: ResendRequest,
  apiKey: Redacted.Redacted<string>
): Effect.Effect<Omit<PreparedRequest, "http">, OutboundHttpFailure> => {
  const authorization = resendAuthorization(apiKey);
  switch (request._tag) {
    case "ResendEmailDelivery":
      return Effect.succeed({
        request: HttpClientRequest.post(`${resendApiBaseUrl}/emails`, {
          headers: {
            ...authorization,
            "content-type": "application/json",
            "idempotency-key": request.idempotencyKey,
          },
          body: HttpBody.text(request.body, "application/json"),
        }),
        maximumResponseBytes: maximumResendDeliveryResponseBytes,
        redirect: "error",
      });
    case "ResendReceivedEmail":
      return Effect.succeed({
        request: HttpClientRequest.get(
          `${resendApiBaseUrl}/emails/receiving/${encodeURIComponent(request.receivedEmailId)}`,
          { headers: authorization }
        ),
        maximumResponseBytes: maximumResendMetadataResponseBytes,
        redirect: "manual",
      });
    case "ResendAttachment":
      return Effect.succeed({
        request: HttpClientRequest.get(
          `${resendApiBaseUrl}/emails/receiving/${encodeURIComponent(request.receivedEmailId)}/attachments/${encodeURIComponent(request.attachmentId)}`,
          { headers: authorization }
        ),
        maximumResponseBytes: maximumResendAttachmentResponseBytes,
        redirect: "manual",
      });
    case "ResendInboundDownload": {
      const decoded = decodeResendInboundDownloadUrl(request.downloadUrl);
      if (Result.isFailure(decoded)) return Effect.fail(invalidDestination());
      return Effect.succeed({
        request: HttpClientRequest.get(decoded.success.href),
        maximumResponseBytes: maximumResendInlineImageResponseBytes,
        redirect: "manual",
      });
    }
  }
};

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
  request: WompiRequest,
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

const isResendRequest = (request: OutboundHttpRequest): request is ResendRequest =>
  request._tag === "ResendEmailDelivery" ||
  request._tag === "ResendReceivedEmail" ||
  request._tag === "ResendAttachment" ||
  request._tag === "ResendInboundDownload";

const resendApiKeyFor = (
  request: ResendRequest,
  deliveryApiKey: Redacted.Redacted<string>,
  receivingApiKey: Redacted.Redacted<string>
): Redacted.Redacted<string> =>
  request._tag === "ResendEmailDelivery" ? deliveryApiKey : receivingApiKey;

type RequestPreparationContext = Readonly<{
  kapsoApiKey: Redacted.Redacted<string>;
  resendEmailDeliveryApiKey: Redacted.Redacted<string>;
  resendReceivingApiKey: Redacted.Redacted<string>;
  wompi: WompiTransportConfig;
  crypto: Crypto.Crypto;
  kapsoHttp: PreparedRequest["http"];
  resendHttp: PreparedRequest["http"];
  wompiHttp: PreparedRequest["http"];
}>;

const prepareNonResendRequest = (
  request: Exclude<OutboundHttpRequest, ResendRequest>,
  context: RequestPreparationContext
): Effect.Effect<PreparedRequest, OutboundHttpFailure> => {
  if (request._tag === "KapsoMessages") {
    return Effect.succeed({
      http: context.kapsoHttp,
      maximumResponseBytes: maximumKapsoResponseBytes,
      request: makeKapsoRequest(request, context.kapsoApiKey),
      redirect: "error",
    });
  }
  return makeWompiRequest(request, context.wompi, context.crypto).pipe(
    Effect.map((wompiRequest) => ({
      http: context.wompiHttp,
      maximumResponseBytes: maximumWompiResponseBytes,
      request: wompiRequest,
      redirect: "error" as const,
    }))
  );
};

const prepareRequest = (
  request: OutboundHttpRequest,
  context: RequestPreparationContext
): Effect.Effect<PreparedRequest, OutboundHttpFailure> => {
  if (!isResendRequest(request)) return prepareNonResendRequest(request, context);
  const apiKey = resendApiKeyFor(
    request,
    context.resendEmailDeliveryApiKey,
    context.resendReceivingApiKey
  );
  return makeResendRequest(request, apiKey).pipe(
    Effect.map((resendRequest) => ({ ...resendRequest, http: context.resendHttp }))
  );
};

/**
 * Creates fixed-destination provider transport that owns credentials, rejects redirects, suppresses
 * trace propagation, bounds response bytes, and returns only retained response facts or closed
 * failures.
 */
export const makeOutboundHttp = ({
  kapsoApiKey,
  resendEmailDeliveryApiKey,
  resendReceivingApiKey,
  wompi,
  httpClient,
  crypto,
}: Readonly<{
  kapsoApiKey: Redacted.Redacted<string>;
  resendEmailDeliveryApiKey: Redacted.Redacted<string>;
  resendReceivingApiKey: Redacted.Redacted<string>;
  wompi: WompiTransportConfig;
  httpClient: HttpClient.HttpClient;
  crypto: Crypto.Crypto;
}>): PrivateOutboundHttpService => {
  const kapsoHttp = makeBoundedExternalHttpClient("kapso")(httpClient);
  const resendHttp = makeBoundedExternalHttpClient("resend")(httpClient);
  const wompiHttp = makeBoundedExternalHttpClient("wompi")(httpClient);
  return {
    execute: (request) => {
      const prepared = prepareRequest(request, {
        kapsoApiKey,
        resendEmailDeliveryApiKey,
        resendReceivingApiKey,
        wompi,
        crypto,
        kapsoHttp,
        resendHttp,
        wompiHttp,
      });
      return prepared.pipe(
        Effect.flatMap(({ http, maximumResponseBytes, request: providerRequest, redirect }) =>
          http
            .execute(providerRequest, maximumResponseBytes)
            .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect }))
        ),
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
