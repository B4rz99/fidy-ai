import { type Crypto, Effect, Encoding, Match, Option, Redacted, Result, Schema } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  type HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { cloudflareAccessSupportRecoveryUrl } from "./cloudflare-access";
import { makeProviderTransport } from "./transport";
import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import {
  OutboundHttpFailure,
  type OutboundHttpRequest,
  type OutboundHttpResponse,
  type SentryAccountResource,
  type WompiTransactionBody,
} from "~/shell/outbound-http/contract";

const kapsoMessagesBaseUrl = "https://api.kapso.ai/meta/whatsapp/v24.0";
const mistralChatCompletionsUrl = "https://api.mistral.ai/v1/chat/completions";
const resendApiBaseUrl = "https://api.resend.com";
const wompiSandboxOrigin = "https://sandbox.wompi.co";
const wompiProductionOrigin = "https://production.wompi.co";
const sentryAccountBaseUrl = "https://sentry.io/api/0";
const bytesPerKibibyte = 1_024;
const maximumKapsoResponseKibibytes = 64;
const maximumWompiResponseKibibytes = 16;
const maximumResendDeliveryResponseKibibytes = 4;
const maximumResendMetadataResponseKibibytes = 1_024;
const maximumResendAttachmentResponseKibibytes = 4;
const maximumResendInlineImageResponseKibibytes = 1_024;
const maximumKapsoResponseBytes = maximumKapsoResponseKibibytes * bytesPerKibibyte;
const maximumWompiResponseBytes = maximumWompiResponseKibibytes * bytesPerKibibyte;
const maximumHostedInferenceResponseBytes = 1_000_000;
const maximumSentryResponseBytes = 65_536;
const maximumCloudflareAccessResponseBytes = 1_024;
const maximumResendDeliveryResponseBytes =
  maximumResendDeliveryResponseKibibytes * bytesPerKibibyte;
const maximumResendMetadataResponseBytes =
  maximumResendMetadataResponseKibibytes * bytesPerKibibyte;
const maximumResendAttachmentResponseBytes =
  maximumResendAttachmentResponseKibibytes * bytesPerKibibyte;
const maximumResendInlineImageResponseBytes =
  maximumResendInlineImageResponseKibibytes * bytesPerKibibyte;

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
  openAiApiKey: Option.Option<Redacted.Redacted<string>>;
  openAiApiUrl: string;
  mistralApiKey: Option.Option<Redacted.Redacted<string>>;
  resendEmailDeliveryApiKey: Option.Option<Redacted.Redacted<string>>;
  resendReceivingApiKey: Option.Option<Redacted.Redacted<string>>;
  wompi: Option.Option<WompiTransportConfig>;
  httpClient: HttpClient.HttpClient;
  crypto: Option.Option<Crypto.Crypto>;
}>;

type ResendAttachmentDownloadRequest = Extract<
  OutboundHttpRequest,
  { readonly _tag: "ResendAttachmentDownload" }
>;
type ResendRequest = Exclude<
  Extract<OutboundHttpRequest, { readonly _tag: `Resend${string}` }>,
  ResendAttachmentDownloadRequest
>;
type StandardOutboundHttpRequest = Exclude<OutboundHttpRequest, ResendAttachmentDownloadRequest>;
type WompiRequest = Extract<OutboundHttpRequest, { readonly _tag: `Wompi${string}` }>;

const unavailableTransport = (): OutboundHttpFailure =>
  new OutboundHttpFailure({
    reason: "transport-failed",
    responseStatus: Option.none(),
    responseHeaders: {},
  });

const rejectRequest = (): Effect.Effect<never, OutboundHttpFailure> =>
  Effect.fail(unavailableTransport());

const invalidDestination = (): OutboundHttpFailure =>
  new OutboundHttpFailure({
    reason: "invalid-destination",
    responseStatus: Option.none(),
    responseHeaders: {},
  });

const jsonRequest = (
  url: string,
  body: string,
  headers: Readonly<Record<string, string>>
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeaders({ "content-type": "application/json", ...headers }),
    HttpClientRequest.setBody(HttpBody.text(body, "application/json"))
  );

const joinUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

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
const ResendAttachmentDescriptor = Schema.Struct({
  download_url: ResendInboundDownloadUrl,
});
const decodeResendAttachmentDescriptor = Schema.decodeUnknownResult(ResendAttachmentDescriptor);

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

const sentryResourcePath = (resource: SentryAccountResource): string => {
  switch (resource._tag) {
    case "Organization":
      return `/organizations/${encodeURIComponent(Redacted.value(resource.organizationSlug))}/`;
    case "OrganizationProjects":
      return `/organizations/${encodeURIComponent(Redacted.value(resource.organizationSlug))}/projects/`;
    case "ProjectKeys":
      return `/projects/${encodeURIComponent(Redacted.value(resource.organizationSlug))}/${encodeURIComponent(Redacted.value(resource.projectSlug))}/keys/`;
    case "ProjectEnvironments":
      return `/projects/${encodeURIComponent(Redacted.value(resource.organizationSlug))}/${encodeURIComponent(Redacted.value(resource.projectSlug))}/environments/`;
  }
};

const makeSentryRequest = (
  request: Extract<OutboundHttpRequest, { readonly _tag: "SentryAccount" }>,
  authToken: Redacted.Redacted<string>
): Omit<PreparedRequest, "http"> => ({
  request: HttpClientRequest.get(
    `${sentryAccountBaseUrl}${sentryResourcePath(request.resource)}`
  ).pipe(HttpClientRequest.setHeaders({ authorization: `Bearer ${Redacted.value(authToken)}` })),
  maximumResponseBytes: maximumSentryResponseBytes,
  redirect: "error",
});

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
  openAiHttp: PreparedRequest["http"];
  mistralHttp: PreparedRequest["http"];
  resendHttp: PreparedRequest["http"];
  wompiHttp: PreparedRequest["http"];
}>;

const prepareResend = (
  request: ResendRequest,
  context: RequestPreparationContext
): Effect.Effect<PreparedRequest, OutboundHttpFailure> => {
  const apiKey =
    request._tag === "ResendEmailDelivery"
      ? context.config.resendEmailDeliveryApiKey
      : context.config.resendReceivingApiKey;
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
    case "OpenAiResponses":
    case "OpenAiInputTokens":
      return Option.match(config.openAiApiKey, {
        onNone: () => Effect.fail(unavailableTransport()),
        onSome: (apiKey) =>
          Effect.succeed({
            http: context.openAiHttp,
            request: jsonRequest(
              joinUrl(
                config.openAiApiUrl,
                request._tag === "OpenAiResponses" ? "responses" : "responses/input_tokens"
              ),
              request.body,
              { authorization: `Bearer ${Redacted.value(apiKey)}` }
            ),
            maximumResponseBytes: maximumHostedInferenceResponseBytes,
            redirect: "error" as const,
          }),
      });
    case "MistralChatCompletions":
      return Option.match(config.mistralApiKey, {
        onNone: () => Effect.fail(unavailableTransport()),
        onSome: (apiKey) =>
          Effect.succeed({
            http: context.mistralHttp,
            request: jsonRequest(mistralChatCompletionsUrl, request.body, {
              authorization: `Bearer ${Redacted.value(apiKey)}`,
            }),
            maximumResponseBytes: maximumHostedInferenceResponseBytes,
            redirect: "error" as const,
          }),
      });
    case "SentryAccount":
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
      OpenAiResponses: (value) => prepareNonProviderGroup(value, context),
      OpenAiInputTokens: (value) => prepareNonProviderGroup(value, context),
      MistralChatCompletions: (value) => prepareNonProviderGroup(value, context),
      SentryAccount: (value) => prepareNonProviderGroup(value, context),
      CloudflareAccessSupportRecovery: (value) => prepareNonProviderGroup(value, context),
      ResendEmailDelivery: (value) => prepareResend(value, context),
      ResendReceivedEmail: (value) => prepareResend(value, context),
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

const firstSuccessfulStatus = 200;
const firstRedirectStatus = 300;
const successfulStatus = (status: number): boolean =>
  status >= firstSuccessfulStatus && status < firstRedirectStatus;

const executeResendAttachmentDownload = (
  request: ResendAttachmentDownloadRequest,
  context: RequestPreparationContext
): Effect.Effect<OutboundHttpResponse, OutboundHttpFailure> =>
  Effect.gen(function* () {
    const apiKey = yield* Effect.fromOption(
      context.config.resendReceivingApiKey,
      unavailableTransport
    );
    const descriptorResponse = yield* executePrepared({
      http: context.resendHttp,
      request: HttpClientRequest.get(
        `${resendApiBaseUrl}/emails/receiving/${encodeURIComponent(request.receivedEmailId)}/attachments/${encodeURIComponent(request.attachmentId)}`,
        { headers: resendAuthorization(apiKey) }
      ),
      maximumResponseBytes: maximumResendAttachmentResponseBytes,
      redirect: "manual",
    });
    if (!successfulStatus(descriptorResponse.status)) return descriptorResponse;

    const json = Schema.decodeResult(UnknownJsonString)(
      new TextDecoder().decode(descriptorResponse.body)
    );
    if (Result.isFailure(json)) return yield* invalidDestination();
    const descriptor = decodeResendAttachmentDescriptor(json.success);
    if (Result.isFailure(descriptor)) return yield* invalidDestination();

    return yield* executePrepared({
      http: context.resendHttp,
      request: HttpClientRequest.get(descriptor.success.download_url.href),
      maximumResponseBytes: maximumResendInlineImageResponseBytes,
      redirect: "manual",
    });
  });

/**
 * Creates fixed-destination provider transport that owns credentials, rejects redirects, suppresses
 * trace propagation, bounds response bytes, and returns only retained response facts or failures.
 */
export const makeOutboundHttp = (config: OutboundHttpConfig): PrivateOutboundHttpService => {
  const context: RequestPreparationContext = {
    config,
    kapsoHttp: makeProviderTransport("kapso")(config.httpClient),
    openAiHttp: makeProviderTransport("openai")(config.httpClient),
    mistralHttp: makeProviderTransport("mistral")(config.httpClient),
    resendHttp: makeProviderTransport("resend")(config.httpClient),
    wompiHttp: makeProviderTransport("wompi")(config.httpClient),
  };
  return {
    execute: (request) =>
      request._tag === "ResendAttachmentDownload"
        ? executeResendAttachmentDownload(request, context)
        : prepareRequest(request, context).pipe(Effect.flatMap(executePrepared)),
  };
};

export const makeSentryOutboundHttp = ({
  authToken,
  httpClient,
}: Readonly<{
  authToken: Redacted.Redacted<string>;
  httpClient: HttpClient.HttpClient;
}>): PrivateOutboundHttpService => {
  const http = makeProviderTransport("sentry")(httpClient);
  return makeService((request) =>
    request._tag === "SentryAccount"
      ? Effect.succeed({ ...makeSentryRequest(request, authToken), http })
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
