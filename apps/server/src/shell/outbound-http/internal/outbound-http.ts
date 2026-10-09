import { DaviplataOtpPolicy } from "~/core/subscription/contract";
import { type WompiEnvironment } from "~/shell/secret-material/contract";
import { type Crypto, Effect, Match, Option, Redacted, Schema } from "effect";
import { Hex } from "effect/encoding";
import { FetchHttpClient, HttpBody, type HttpClient, HttpClientRequest } from "effect/http";
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
/** Application safety bound, not Kapso's maximum supported media size. */
const maximumKapsoMediaMebibytes = 10;
const maximumKapsoMediaResponseBytes =
  maximumKapsoMediaMebibytes * bytesPerKibibyte * bytesPerKibibyte;
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
  environment: WompiEnvironment;
  publicKey: string;
  privateKey: Redacted.Redacted<string>;
  integritySecret: Redacted.Redacted<string>;
  daviplataSandboxPolicy: Option.Option<DaviplataOtpPolicy>;
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
    redirect: "manual",
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
    .pipe(Effect.map(Hex.encode), Effect.mapError(unavailableTransport));

const walletApprovalRequest = (
  config: WompiTransportConfig,
  token: Redacted.Redacted<string>,
  method: "nequi" | "daviplata"
): HttpClientRequest.HttpClientRequest => {
  const origin = { sandbox: wompiSandboxOrigin, production: wompiProductionOrigin }[
    config.environment
  ];
  return HttpClientRequest.get(
    `${origin}/v1/tokens/${method}/${encodeURIComponent(Redacted.value(token))}`,
    {
      headers: { authorization: `Bearer ${config.publicKey}` },
    }
  );
};

const nequiSandboxTokenRequest = (
  config: WompiTransportConfig,
  outcome: "approved" | "declined"
): Effect.Effect<HttpClientRequest.HttpClientRequest, OutboundHttpFailure> =>
  config.environment !== "sandbox"
    ? rejectRequest()
    : Effect.succeed(
        jsonRequest(
          `${wompiSandboxOrigin}/v1/tokens/nequi`,
          JSON.stringify({ phone_number: outcome === "approved" ? "3991111111" : "3992222222" }),
          { authorization: `Bearer ${config.publicKey}` }
        )
      );

const sandboxOtpPolicy = (config: WompiTransportConfig): Option.Option<DaviplataOtpPolicy> =>
  config.environment !== "sandbox"
    ? Option.none()
    : config.daviplataSandboxPolicy.pipe(
        Option.flatMap(Schema.decodeUnknownOption(DaviplataOtpPolicy)),
        Option.filter(
          (policy) =>
            policy.sendUrl.startsWith(`${wompiSandboxOrigin}/`) &&
            policy.confirmUrl.startsWith(`${wompiSandboxOrigin}/`)
        )
      );

const daviplataSandboxRequest = (
  config: WompiTransportConfig,
  request: Extract<
    WompiRequest,
    { _tag: "WompiDaviplataSandboxToken" | "WompiDaviplataSandboxOtp" }
  >
): Effect.Effect<HttpClientRequest.HttpClientRequest, OutboundHttpFailure> =>
  Option.match(sandboxOtpPolicy(config), {
    onNone: rejectRequest,
    onSome: (policy) => {
      if (request._tag === "WompiDaviplataSandboxToken") {
        return Effect.succeed(
          jsonRequest(
            `${wompiSandboxOrigin}/v1/tokens/daviplata`,
            JSON.stringify({
              type_document: "CC",
              number_document: "1122233",
              product_number: request.outcome === "approved" ? "3991111111" : "3992222222",
            }),
            { authorization: `Bearer ${config.publicKey}` }
          )
        );
      }
      const headers = { authorization: `Bearer ${Redacted.value(request.token)}` };
      return Effect.succeed(
        request.step === "send"
          ? HttpClientRequest.post(policy.sendUrl, { headers })
          : jsonRequest(policy.confirmUrl, JSON.stringify({ code: "574829" }), headers)
      );
    },
  });

const paymentMethodFields = {
  card: { payment_method: { installments: 1 } },
  nequi: {},
  daviplata: {},
} as const satisfies Readonly<Record<WompiTransactionBody["method"], object>>;

const signedTransactionBody = (
  body: Extract<OutboundHttpRequest, { _tag: "WompiCreateTransaction" }>["body"],
  signature: string
): string =>
  JSON.stringify({
    amount_in_cents: body.amountInCents,
    currency: body.currency,
    customer_email: body.billingEmail,
    ...paymentMethodFields[body.method],
    payment_source_id: body.sourceId,
    reference: body.reference,
    signature,
  });

const makeSandboxCorrectionRequest = (
  request: Extract<WompiRequest, { _tag: "WompiSandboxRefund" | "WompiSandboxCardVoid" }>,
  config: WompiTransportConfig
): Effect.Effect<HttpClientRequest.HttpClientRequest, OutboundHttpFailure> => {
  if (config.environment !== "sandbox") return rejectRequest();
  const authorization = `Bearer ${Redacted.value(config.privateKey)}`;
  return Effect.succeed(
    request._tag === "WompiSandboxRefund"
      ? jsonRequest(`${wompiSandboxOrigin}/v1/refunds`, request.body, { authorization })
      : HttpClientRequest.post(
          `${wompiSandboxOrigin}/v1/transactions/${encodeURIComponent(request.transactionId)}/void`,
          { headers: { authorization } }
        )
  );
};

const makeSignedTransactionRequest = (
  config: WompiTransportConfig,
  crypto: Crypto.Crypto,
  body: WompiTransactionBody
): Effect.Effect<HttpClientRequest.HttpClientRequest, OutboundHttpFailure> => {
  const origin = config.environment === "sandbox" ? wompiSandboxOrigin : wompiProductionOrigin;
  return transactionSignature(crypto, config.integritySecret, body).pipe(
    Effect.map((signature) =>
      jsonRequest(`${origin}/v1/transactions`, signedTransactionBody(body, signature), {
        authorization: `Bearer ${Redacted.value(config.privateKey)}`,
      })
    )
  );
};

const makeWompiRequest = (
  request: WompiRequest,
  config: WompiTransportConfig,
  crypto: Crypto.Crypto
): Effect.Effect<HttpClientRequest.HttpClientRequest, OutboundHttpFailure> => {
  const origin = { sandbox: wompiSandboxOrigin, production: wompiProductionOrigin }[
    config.environment
  ];
  const authorization = `Bearer ${Redacted.value(config.privateKey)}`;
  return Match.value(request).pipe(
    Match.tagsExhaustive({
      WompiMerchant: () =>
        Effect.succeed(
          HttpClientRequest.get(`${origin}/v1/merchants/${encodeURIComponent(config.publicKey)}`)
        ),
      WompiNequiSandboxToken: (value) => nequiSandboxTokenRequest(config, value.outcome),
      WompiDaviplataSandboxToken: (value) => daviplataSandboxRequest(config, value),
      WompiDaviplataSandboxOtp: (value) => daviplataSandboxRequest(config, value),
      WompiNequiApproval: (value) =>
        Effect.succeed(walletApprovalRequest(config, value.token, "nequi")),
      WompiDaviplataApproval: (value) =>
        Effect.succeed(walletApprovalRequest(config, value.token, "daviplata")),
      WompiCreatePaymentSource: (value) =>
        Effect.succeed(
          HttpClientRequest.post(`${origin}/v1/payment_sources`, {
            headers: { authorization, "content-type": "application/json" },
            body: HttpBody.text(value.body, "application/json"),
          })
        ),
      WompiVoidPaymentSource: (value) =>
        Effect.succeed(
          HttpClientRequest.put(
            `${origin}/v1/payment_sources/${encodeURIComponent(value.sourceId)}/void`,
            { headers: { authorization } }
          )
        ),
      WompiVerifyPaymentSource: (value) =>
        Effect.succeed(
          HttpClientRequest.get(
            `${origin}/v1/payment_sources/${encodeURIComponent(value.sourceId)}`,
            {
              headers: { authorization },
            }
          )
        ),
      WompiCreateTransaction: (value) => makeSignedTransactionRequest(config, crypto, value.body),
      WompiSandboxRefund: (value) => makeSandboxCorrectionRequest(value, config),
      WompiSandboxCardVoid: (value) => makeSandboxCorrectionRequest(value, config),
      WompiFindTransaction: (value) =>
        Effect.succeed(
          HttpClientRequest.get(
            `${origin}/v1/transactions/${encodeURIComponent(value.transactionId)}`,
            {
              headers: { authorization },
            }
          )
        ),
    })
  );
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
            redirect: "manual" as const,
          }))
        ),
    })
  );

const prepareKapsoStatus = (
  request: Extract<StandardOutboundHttpRequest, { _tag: "KapsoMessageStatus" }>,
  context: RequestPreparationContext
): Effect.Effect<PreparedRequest, OutboundHttpFailure> =>
  Option.match(context.config.kapsoApiKey, {
    onNone: () => Effect.fail(unavailableTransport()),
    onSome: (apiKey) =>
      Effect.succeed({
        http: context.kapsoHttp,
        request: HttpClientRequest.get(
          `${kapsoMessagesBaseUrl}/${encodeURIComponent(request.businessPhoneNumberId)}/messages/${encodeURIComponent(request.messageId)}?fields=kapso`,
          { headers: { "x-api-key": Redacted.value(apiKey) } }
        ),
        maximumResponseBytes: maximumKapsoResponseBytes,
        redirect: "manual" as const,
      }),
  });

const prepareNonProviderGroup = (
  request: Exclude<StandardOutboundHttpRequest, ResendRequest | WompiRequest>,
  context: RequestPreparationContext
): Effect.Effect<PreparedRequest, OutboundHttpFailure> => {
  const config = context.config;
  switch (request._tag) {
    case "KapsoMessageStatus":
      return prepareKapsoStatus(request, context);
    case "KapsoMediaMetadata":
    case "KapsoMediaDownload":
      return Option.match(config.kapsoApiKey, {
        onNone: () => Effect.fail(unavailableTransport()),
        onSome: (apiKey) =>
          Effect.succeed({
            http: context.kapsoHttp,
            request:
              request._tag === "KapsoMediaMetadata"
                ? HttpClientRequest.get(
                    `${kapsoMessagesBaseUrl}/${encodeURIComponent(request.mediaId)}?phone_number_id=${encodeURIComponent(request.businessPhoneNumberId)}`,
                    { headers: { "x-api-key": Redacted.value(apiKey) } }
                  )
                : HttpClientRequest.get(
                    `https://api.kapso.ai/meta/whatsapp/media_download?token=${encodeURIComponent(Redacted.value(request.token))}`
                  ),
            maximumResponseBytes:
              request._tag === "KapsoMediaMetadata"
                ? maximumKapsoResponseBytes
                : maximumKapsoMediaResponseBytes,
            redirect: "manual" as const,
          }),
      });
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
            redirect: "manual" as const,
          }),
      });
    case "CloudflareAccessSupportRecovery":
    case "CloudflareAccessSigningKeys":
      return rejectRequest();
  }
};

const prepareRequest = (
  request: StandardOutboundHttpRequest,
  context: RequestPreparationContext
): Effect.Effect<PreparedRequest, OutboundHttpFailure> =>
  Match.value(request).pipe(
    Match.tagsExhaustive({
      KapsoMediaMetadata: (value) => prepareNonProviderGroup(value, context),
      KapsoMediaDownload: (value) => prepareNonProviderGroup(value, context),
      KapsoMessages: (value) => prepareNonProviderGroup(value, context),
      KapsoMessageStatus: (value) => prepareNonProviderGroup(value, context),
      CloudflareAccessSupportRecovery: (value) => prepareNonProviderGroup(value, context),
      CloudflareAccessSigningKeys: (value) => prepareNonProviderGroup(value, context),
      ResendEmailDelivery: (value) => prepareResend(value, context),
      WompiMerchant: (value) => prepareWompi(value, context),
      WompiNequiApproval: (value) => prepareWompi(value, context),
      WompiDaviplataApproval: (value) => prepareWompi(value, context),
      WompiNequiSandboxToken: (value) => prepareWompi(value, context),
      WompiDaviplataSandboxToken: (value) => prepareWompi(value, context),
      WompiDaviplataSandboxOtp: (value) => prepareWompi(value, context),
      WompiCreatePaymentSource: (value) => prepareWompi(value, context),
      WompiVerifyPaymentSource: (value) => prepareWompi(value, context),
      WompiVoidPaymentSource: (value) => prepareWompi(value, context),
      WompiCreateTransaction: (value) => prepareWompi(value, context),
      WompiFindTransaction: (value) => prepareWompi(value, context),
      WompiSandboxRefund: (value) => prepareWompi(value, context),
      WompiSandboxCardVoid: (value) => prepareWompi(value, context),
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
 * Creates fixed-destination provider transport that owns credentials, refuses automatic redirect
 * following, suppresses trace propagation, bounds response bytes, and returns only retained response
 * facts or failures.
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

/** Configuration, never a request-supplied URL, selects one Cloudflare Access team's signing keys. */
export const makeCloudflareAccessSigningKeysHttp = ({
  issuer,
  httpClient,
}: Readonly<{
  issuer: string;
  httpClient: HttpClient.HttpClient;
}>): PrivateOutboundHttpService => {
  const http = makeProviderTransport("cloudflare-access")(httpClient);
  return makeService((request) =>
    request._tag === "CloudflareAccessSigningKeys" &&
    /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u.test(issuer)
      ? Effect.succeed({
          http,
          request: HttpClientRequest.get(`${issuer}/cdn-cgi/access/certs`),
          maximumResponseBytes: maximumWompiResponseBytes,
          redirect: "manual" as const,
        })
      : rejectRequest()
  );
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
