import { UnknownJsonString } from "~/schema-compatibility";
import {
  Config,
  Context,
  Data,
  DateTime,
  Effect,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient, type HttpClientResponse } from "effect/unstable/http";
import sharp, { type Metadata } from "sharp";
import {
  forwardedEmailRetrievalDeadline,
  maximumEmailInlineImageBytes,
  maximumEmailInlineImageDimension,
  maximumEmailInlineImages,
} from "~/core/ingestion/email-policy";
import { ReceivedEmailContent, ReceivedInlineImage } from "~/core/ingestion/model";
import { ResendReceivedEmailId } from "~/core/ingestion/reference";
import { collectBoundedResponseBytes } from "~/shell/_shared/bounded-bytes";

/** Closed bounded failure set exposed by direct Resend retrieval. */
export class ResendReceivingFailed extends Data.TaggedError("ResendReceivingFailed")<{
  readonly reason: "provider-unavailable" | "invalid-provider-response" | "resource-limit";
}> {}

/** Retrieval adapter that returns only bounded text, HTML, and validated inline images. */
export type ResendReceivingClientService = Readonly<{
  retrieveEmail: (
    receivedEmailId: ResendReceivedEmailId
  ) => Effect.Effect<ReceivedEmailContent, ResendReceivingFailed>;
}>;

// Three minutes covers the bounded worst case of metadata plus eight two-at-a-time inline-image
// descriptor/download pairs and leaves margin around their individual 14-second request deadlines.
const maximumMetadataBytes = 1_048_576;
const maximumAttachmentDescriptorBytes = 4_096;
const firstSuccessfulStatus = 200;
const firstRedirectStatus = 300;
const tooManyRequestsStatus = 429;
const firstServerFailureStatus = 500;
const successful = (status: number): boolean =>
  status >= firstSuccessfulStatus && status < firstRedirectStatus;
const providerHttpFailureReason = (status: number): ResendReceivingFailed["reason"] =>
  [status === tooManyRequestsStatus, status >= firstServerFailureStatus].some(Boolean)
    ? "provider-unavailable"
    : "invalid-provider-response";

const getProviderResponse = (
  client: HttpClient.HttpClient,
  url: string,
  authorization: Option.Option<string>
): Effect.Effect<HttpClientResponse.HttpClientResponse, ResendReceivingFailed> =>
  client
    .get(
      url,
      Option.match(authorization, {
        onNone: () => undefined,
        onSome: (value) => ({ headers: { authorization: value } }),
      })
    )
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout("14 seconds"),
      Effect.mapError(() => new ResendReceivingFailed({ reason: "provider-unavailable" }))
    );

const AttachmentMetadata = Schema.Struct({
  id: Schema.NonEmptyString,
  content_type: Schema.String,
  content_disposition: Schema.OptionFromNullOr(Schema.String),
  content_id: Schema.OptionFromNullOr(Schema.String),
  size: Schema.Int,
});

const ReceivedEmailResponse = Schema.Struct({
  id: ResendReceivedEmailId,
  from: Schema.String,
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  text: Schema.OptionFromNullOr(Schema.String),
  html: Schema.OptionFromNullOr(Schema.String),
  message_id: Schema.OptionFromNullOr(Schema.String),
  created_at: Schema.DateTimeUtcFromString,
  attachments: Schema.Array(AttachmentMetadata),
});

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

const AttachmentResponse = Schema.Struct({
  download_url: ResendInboundDownloadUrl,
});

const parseJsonResponse = Effect.fn("Resend.parseReceivingResponse")(function* <A>(
  response: HttpClientResponse.HttpClientResponse,
  decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
  maximumBytes: number
) {
  if (!successful(response.status)) {
    return yield* new ResendReceivingFailed({
      reason: providerHttpFailureReason(response.status),
    });
  }
  const body = yield* collectBoundedResponseBytes(response, maximumBytes).pipe(
    Effect.mapError(() => new ResendReceivingFailed({ reason: "resource-limit" }))
  );
  if (Option.isNone(body)) {
    return yield* new ResendReceivingFailed({ reason: "resource-limit" });
  }
  const json = Schema.decodeResult(UnknownJsonString)(new TextDecoder().decode(body.value));
  if (Result.isFailure(json)) {
    return yield* new ResendReceivingFailed({ reason: "invalid-provider-response" });
  }
  return yield* decode(json.success).pipe(
    Effect.mapError(() => new ResendReceivingFailed({ reason: "invalid-provider-response" }))
  );
});

type ResendRetrievalDeadline = <A>(
  retrieval: Effect.Effect<A, ResendReceivingFailed>
) => Effect.Effect<A, ResendReceivingFailed>;

const withResendRetrievalDeadline: ResendRetrievalDeadline = (retrieval) =>
  retrieval.pipe(
    Effect.timeout(forwardedEmailRetrievalDeadline),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new ResendReceivingFailed({ reason: "provider-unavailable" }))
    )
  );

const inlineMediaTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const maximumInlineImagePixels =
  maximumEmailInlineImageDimension * maximumEmailInlineImageDimension;
const inlineImageDownloadConcurrency = 2;
const sharpFormatByMediaType: Readonly<Record<string, string>> = {
  "image/gif": "gif",
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

const metadataMatchesDeclaration = (metadata: Metadata, mediaType: string): boolean => {
  if (metadata.format !== sharpFormatByMediaType[mediaType]) return false;
  const pages = Option.getOrElse(Option.fromUndefinedOr(metadata.pages), () => 1);
  if (pages !== 1) return false;
  const width = Option.getOrElse(Option.fromUndefinedOr(metadata.width), () => 0);
  const height = Option.getOrElse(Option.fromUndefinedOr(metadata.height), () => 0);
  if (width <= 0) return false;
  if (height <= 0) return false;
  if (width > maximumEmailInlineImageDimension) return false;
  return height <= maximumEmailInlineImageDimension;
};

const hasSafeDeclaredImage = Effect.fn("Resend.hasSafeDeclaredImage")(function* (
  mediaType: string,
  bytes: Uint8Array
) {
  const metadata = yield* Effect.tryPromise({
    try: () => sharp(bytes, { limitInputPixels: maximumInlineImagePixels, pages: 1 }).metadata(),
    catch: () => undefined,
  }).pipe(Effect.option);
  return Option.exists(metadata, (value) => metadataMatchesDeclaration(value, mediaType));
});

type InlineAttachment = typeof AttachmentMetadata.Type;

const isSupportedInlineAttachment = (attachment: InlineAttachment): boolean =>
  [
    Option.contains(attachment.content_disposition, "inline"),
    Option.isSome(attachment.content_id),
    inlineMediaTypes.has(attachment.content_type),
  ].every(Boolean);

const retrieveInlineImage = Effect.fn("Resend.retrieveInlineImage")(function* (input: {
  client: HttpClient.HttpClient;
  baseUrl: string;
  authorization: string;
  attachment: InlineAttachment;
}) {
  const descriptorResponse = yield* getProviderResponse(
    input.client,
    `${input.baseUrl}/attachments/${encodeURIComponent(input.attachment.id)}`,
    Option.some(input.authorization)
  );
  const descriptor = yield* parseJsonResponse(
    descriptorResponse,
    Schema.decodeUnknownEffect(AttachmentResponse),
    maximumAttachmentDescriptorBytes
  );
  const imageResponse = yield* getProviderResponse(
    input.client,
    descriptor.download_url.href,
    Option.none()
  );
  if (!successful(imageResponse.status)) {
    return yield* new ResendReceivingFailed({
      reason: providerHttpFailureReason(imageResponse.status),
    });
  }
  const bytes = yield* collectBoundedResponseBytes(
    imageResponse,
    maximumEmailInlineImageBytes
  ).pipe(Effect.mapError(() => new ResendReceivingFailed({ reason: "resource-limit" })));
  if (Option.isNone(bytes)) return yield* new ResendReceivingFailed({ reason: "resource-limit" });
  if (!(yield* hasSafeDeclaredImage(input.attachment.content_type, bytes.value))) {
    return yield* new ResendReceivingFailed({ reason: "invalid-provider-response" });
  }
  return yield* Schema.decodeUnknownEffect(ReceivedInlineImage)({
    contentId: Option.getOrThrow(input.attachment.content_id),
    mediaType: input.attachment.content_type,
    content: bytes.value,
  }).pipe(
    Effect.mapError(() => new ResendReceivingFailed({ reason: "invalid-provider-response" }))
  );
});

const retrieveReceivedEmail = Effect.fn("Resend.retrieveReceivedEmail")(function* (input: {
  client: HttpClient.HttpClient;
  apiKey: Redacted.Redacted<string>;
  receivedEmailId: ResendReceivedEmailId;
}) {
  const authorization = `Bearer ${Redacted.value(input.apiKey)}`;
  const baseUrl = `https://api.resend.com/emails/receiving/${encodeURIComponent(input.receivedEmailId)}`;
  const response = yield* getProviderResponse(input.client, baseUrl, Option.some(authorization));
  const email = yield* parseJsonResponse(
    response,
    Schema.decodeUnknownEffect(ReceivedEmailResponse),
    maximumMetadataBytes
  );
  const inline = email.attachments.filter(isSupportedInlineAttachment);
  if (
    inline.length > maximumEmailInlineImages ||
    inline.some((attachment) => attachment.size > maximumEmailInlineImageBytes)
  ) {
    return yield* new ResendReceivingFailed({ reason: "resource-limit" });
  }
  const inlineImages = yield* Effect.forEach(
    inline,
    (attachment) =>
      retrieveInlineImage({ client: input.client, baseUrl, authorization, attachment }),
    { concurrency: inlineImageDownloadConcurrency }
  );
  return yield* Schema.decodeEffect(ReceivedEmailContent)({
    receivedEmailId: email.id,
    from: email.from,
    to: email.to,
    subject: email.subject,
    ...(Option.isSome(email.text) ? { text: email.text.value } : {}),
    ...(Option.isSome(email.html) ? { html: email.html.value } : {}),
    inlineImages,
    ...(Option.isSome(email.message_id) ? { messageId: email.message_id.value } : {}),
    createdAt: DateTime.formatIso(email.created_at),
  }).pipe(
    Effect.mapError(() => new ResendReceivingFailed({ reason: "invalid-provider-response" }))
  );
});

/** The direct, bounded Resend received-email client; ordinary attachments never cross this seam. */
export class ResendReceivingClient extends Context.Service<
  ResendReceivingClient,
  ResendReceivingClientService
>()("@fidy/server/shell/ingestion/resend-receiving-client/ResendReceivingClient") {
  static readonly layer = Layer.effect(
    ResendReceivingClient,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const apiKey = yield* Config.redacted("RESEND_API_KEY");
      return ResendReceivingClient.of({
        retrieveEmail: (receivedEmailId) =>
          retrieveReceivedEmail({ client: httpClient, apiKey, receivedEmailId }).pipe(
            withResendRetrievalDeadline
          ),
      });
    })
  );
}
