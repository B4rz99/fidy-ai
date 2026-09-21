import { type Crypto, Effect, Encoding, Match, Option, Redacted } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  type HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { makeProviderTransport } from "./transport";
import {
  OutboundHttpFailure,
  type OutboundHttpRequest,
  type OutboundHttpResponse,
  type WompiTransactionBody,
} from "~/shell/outbound-http/contract";

const cloudflareAccessSupportRecoveryUrl = "https://api.fidyapp.com/internal/support-recovery";
const kapsoMessagesBaseUrl = "https://api.kapso.ai/meta/whatsapp/v24.0";
const resendApiBaseUrl = "https://api.resend.com";
const wompiSandboxOrigin = "https://sandbox.wompi.co";
const wompiProductionOrigin = "https://production.wompi.co";
const bytesPerKibibyte = 1_024;
const maximumKapsoResponseKibibytes = 64;
const maximumWompiResponseKibibytes = 16;
const maximumResendDeliveryResponseKibibytes = 4;
const maximumKapsoResponseBytes = maximumKapsoResponseKibibytes * bytesPerKibibyte;
const maximumWompiResponseBytes = maximumWompiResponseKibibytes * bytesPerKibibyte;
const maximumCloudflareAccessResponseBytes = 1_024;
const maximumResendDeliveryResponseBytes =
  maximumResendDeliveryResponseKibibytes * bytesPerKibibyte;

type PreparedRequest = Readonly<{
  http: ReturnType<ReturnType<typeof makeProviderTransport>>;
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

type OutboundHttpConfig = Readonly<{
  kapsoApiKey: Option.Option<Redacted.Redacted<string>>;
  resendEmailDeliveryApiKey: Option.Option<Redacted.Redacted<string>>;
  wompi: Option.Option<WompiTransportConfig>;
  httpClient: HttpClient.HttpClient;
  crypto: Option.Option<Crypto.Crypto>;
}>;

type ResendRequest = Extract<OutboundHttpRequest, { readonly _tag: `Resend${string}` }>;
type StandardOutboundHttpRequest = OutboundHttpRequest;
type WompiRequest = Extract<OutboundHttpRequest, { readonly _tag: `Wompi${string}` }>;

const unavailableTransport = (): OutboundHttpFailure =>
  new OutboundHttpFailure({
    reason: "transport-failed",
    responseStatus: Option.none(),
    responseHeaders: {},
  });

const rejectRequest = (): Effect.Effect<never, OutboundHttpFailure> =>
  Effect.fail(unavailableTransport());

const jsonRequest = (
  url: string,
  body: string,
  headers: Readonly<Record<string, string>>
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeaders({ "content-type": "application/json", ...headers }),
    HttpClientRequest.setBody(HttpBody.text(body, "application/json"))
  );

const resendAuthorization = (
  apiKey: Redacted.Redacted<string>
): Readonly<Record<string, string>> => ({ authorization: `Bearer ${Redacted.value(apiKey)}` });

const makeResendRequest = (
  request: ResendRequest,
  apiKey: Redacted.Redacted<string>
): Effect.Effect<Omit<PreparedRequest, "http">, OutboundHttpFailure> => {
  const authorization = resendAuthorization(apiKey);
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

const makeCloudflareAccessRequest = (
  request: Extract<OutboundHttpRequest, { readonly _tag: "CloudflareAccessSupportRecovery" }>,
  accessToken: Redacted.Redacted<string>
): Omit<PreparedRequest, "http"> => ({
  request: jsonRequest(cloudflareAccessSupportRecoveryUrl, request.body, {
    "cf-access-token": Redacted.value(accessToken),
  }),
  maximumResponseBytes: maximumCloudflareAccessResponseBytes,
  redirect: "error",
});

type RequestPreparationContext = Readonly<{
  config: OutboundHttpConfig;
  kapsoHttp: PreparedRequest["http"];
  resendHttp: PreparedRequest["http"];
  wompiHttp: PreparedRequest["http"];
}>;

const prepareResend = (
  request: ResendRequest,
  context: RequestPreparationContext
): Effect.Effect<PreparedRequest, OutboundHttpFailure> => {
  const apiKey = context.config.resendEmailDeliveryApiKey;
  return Option.match(apiKey, {
    onNone: () => Effect.fail(unavailableTransport()),
    onSome: (key) =>
      makeResendRequest(request, key).pipe(
        Effect.map((prepared) => ({ ...prepared, http: context.resendHttp }))
      ),
  });
};

const prepareWompi = (
  request: WompiRequest,
  context: RequestPreparationContext
): Effect.Effect<PreparedRequest, OutboundHttpFailure> =>
  Option.all({ wompi: context.config.wompi, crypto: context.config.crypto }).pipe(
    Option.match({
      onNone: () => Effect.fail(unavailableTransport()),
      onSome: ({ wompi, crypto }) =>
        makeWompiRequest(request, wompi, crypto).pipe(
          Effect.map((providerRequest) => ({
            http: context.wompiHttp,
            maximumResponseBytes: maximumWompiResponseBytes,
            request: providerRequest,
            redirect: "error" as const,
          }))
        ),
    })
  );

const prepareNonProviderGroup = (
  request: Exclude<StandardOutboundHttpRequest, ResendRequest | WompiRequest>,
  context: RequestPreparationContext
): Effect.Effect<PreparedRequest, OutboundHttpFailure> => {
  const config = context.config;
  switch (request._tag) {
    case "KapsoMessages":
      return Option.match(config.kapsoApiKey, {
        onNone: () => Effect.fail(unavailableTransport()),
        onSome: (apiKey) =>
          Effect.succeed({
            http: context.kapsoHttp,
            request: jsonRequest(
              `${kapsoMessagesBaseUrl}/${encodeURIComponent(request.businessPhoneNumberId)}/messages`,
              request.body,
              { "x-api-key": Redacted.value(apiKey) }
            ),
            maximumResponseBytes: maximumKapsoResponseBytes,
            redirect: "error" as const,
          }),
      });
    case "CloudflareAccessSupportRecovery":
      return rejectRequest();
  }
};

const prepareRequest = (
  request: StandardOutboundHttpRequest,
  context: RequestPreparationContext
): Effect.Effect<PreparedRequest, OutboundHttpFailure> =>
  Match.value(request).pipe(
    Match.tagsExhaustive({
      KapsoMessages: (value) => prepareNonProviderGroup(value, context),
      CloudflareAccessSupportRecovery: (value) => prepareNonProviderGroup(value, context),
      ResendEmailDelivery: (value) => prepareResend(value, context),
      WompiMerchant: (value) => prepareWompi(value, context),
      WompiCreatePaymentSource: (value) => prepareWompi(value, context),
      WompiVerifyPaymentSource: (value) => prepareWompi(value, context),
      WompiCreateTransaction: (value) => prepareWompi(value, context),
      WompiFindTransaction: (value) => prepareWompi(value, context),
    })
  );

const executePrepared = ({
  http,
  maximumResponseBytes,
  request,
  redirect,
}: PreparedRequest): Effect.Effect<OutboundHttpResponse, OutboundHttpFailure> =>
  http.execute(request, maximumResponseBytes).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect }),
    Effect.map((response) => ({
      status: response.status,
      headers: { ...response.headers },
      body: response.body,
    }))
  );

const makeService = (
  prepare: (request: OutboundHttpRequest) => Effect.Effect<PreparedRequest, OutboundHttpFailure>
): PrivateOutboundHttpService => ({
  execute: (request) => prepare(request).pipe(Effect.flatMap(executePrepared)),
});

/**
 * Creates fixed-destination provider transport that owns credentials, rejects redirects, suppresses
 * trace propagation, bounds response bytes, and returns only retained response facts or failures.
 */
export const makeOutboundHttp = (config: OutboundHttpConfig): PrivateOutboundHttpService => {
  const context: RequestPreparationContext = {
    config,
    kapsoHttp: makeProviderTransport("kapso")(config.httpClient),
    resendHttp: makeProviderTransport("resend")(config.httpClient),
    wompiHttp: makeProviderTransport("wompi")(config.httpClient),
  };
  return {
    execute: (request) => prepareRequest(request, context).pipe(Effect.flatMap(executePrepared)),
  };
};

export const makeCloudflareAccessOutboundHttp = ({
  accessToken,
  httpClient,
}: Readonly<{
  accessToken: Redacted.Redacted<string>;
  httpClient: HttpClient.HttpClient;
}>): PrivateOutboundHttpService => {
  const http = makeProviderTransport("cloudflare-access")(httpClient);
  return makeService((request) =>
    request._tag === "CloudflareAccessSupportRecovery"
      ? Effect.succeed({ ...makeCloudflareAccessRequest(request, accessToken), http })
      : rejectRequest()
  );
};
