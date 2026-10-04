import { Config, Context, Data, DateTime, Effect, Layer, Option, Schema } from "effect";
import { type WhatsAppBusinessScopedUserId } from "~/core/identity/contract";
import { type TranscriptText } from "~/core/agent/contract";
import {
  type DisclosureDeliveryCorrelationToken,
  type DisclosureDeliveryFailureReason,
  type HostedDeliveryCorrelationToken,
  type WhatsAppDelivery,
  type WhatsAppDeliveryCertainty,
  WhatsAppProviderMessageId,
  WhatsAppSendFailed,
  type WhatsAppSentMessage,
} from "~/shell/channels/whatsapp/contract";
import { TelemetryHttpStatus } from "~/shell/observability/contract";
import { type OutboundHttpFailure } from "~/shell/outbound-http/contract";
import { OutboundHttp, type OutboundHttpService } from "~/shell/outbound-http/operations";
import {
  firstServerErrorStatus,
  forbiddenStatus,
  lastServerErrorStatus,
  okStatus,
  requestTimeoutStatus,
  tooManyRequestsStatus,
  unauthorizedStatus,
} from "~/shell/public-http/contract";
import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import { classifyKapsoMetaFailureCode } from "./kapso-failure";

const kapsoRequestTimeoutMilliseconds = 14_000;
const firstNonSuccessStatus = 300;

const isSuccessfulStatus = (status: number): boolean =>
  status >= okStatus && status < firstNonSuccessStatus;

class KapsoInvalidResponse extends Data.TaggedError("KapsoInvalidResponse")<{
  readonly deliveryCertainty: WhatsAppDeliveryCertainty;
  readonly responseStatus: Option.Option<TelemetryHttpStatus>;
}> {}

const rejected = (
  safeReason: DisclosureDeliveryFailureReason,
  automaticRetry = false,
  responseStatus: Option.Option<TelemetryHttpStatus> = Option.none()
): WhatsAppSendFailed =>
  new WhatsAppSendFailed({
    safeReason,
    deliveryCertainty: "rejected",
    automaticRetry,
    responseStatus,
  });

const ambiguous = (
  safeReason: DisclosureDeliveryFailureReason,
  responseStatus: Option.Option<TelemetryHttpStatus> = Option.none()
): WhatsAppSendFailed =>
  new WhatsAppSendFailed({
    safeReason,
    deliveryCertainty: "ambiguous",
    automaticRetry: false,
    responseStatus,
  });

const invalidKapsoResponse = (
  responseStatus: Option.Option<TelemetryHttpStatus>,
  deliveryCertainty: WhatsAppDeliveryCertainty
): KapsoInvalidResponse => new KapsoInvalidResponse({ deliveryCertainty, responseStatus });

const SendResponse = Schema.Struct({
  messaging_product: Schema.Literal("whatsapp"),
  messages: Schema.Tuple([Schema.Struct({ id: WhatsAppProviderMessageId })]),
});

const MetaFailureResponse = Schema.Struct({
  error: Schema.Struct({ code: Schema.Finite }),
});
const KapsoFailureResponse = Schema.Struct({ error: Schema.String });

const classifyFailureBody = (
  body: unknown,
  responseStatus: TelemetryHttpStatus
): WhatsAppSendFailed => {
  const status = Option.some(responseStatus);
  const metaFailure = Schema.decodeUnknownOption(MetaFailureResponse)(body);
  if (Option.isSome(metaFailure)) {
    const disposition = classifyKapsoMetaFailureCode(metaFailure.value.error.code);
    return rejected(disposition.safeReason, disposition.automaticRetry, status);
  }
  const kapsoFailure = Schema.decodeUnknownOption(KapsoFailureResponse)(body);
  if (
    Option.isSome(kapsoFailure) &&
    kapsoFailure.value.error.toLowerCase() === "sandbox numbers do not support bsuid recipients"
  ) {
    return rejected("sandbox_bsuid_unsupported", false, status);
  }
  return rejected("invalid_response", false, status);
};

const classifyHttpStatus = (status: TelemetryHttpStatus): Option.Option<WhatsAppSendFailed> => {
  const responseStatus = Option.some(status);
  if (status === unauthorizedStatus || status === forbiddenStatus) {
    return Option.some(rejected("authentication_failed", false, responseStatus));
  }
  if (status === requestTimeoutStatus) return Option.some(ambiguous("timeout", responseStatus));
  if (status === tooManyRequestsStatus) {
    return Option.some(rejected("rate_limited", true, responseStatus));
  }
  if (status >= firstServerErrorStatus && status <= lastServerErrorStatus) {
    return Option.some(ambiguous("provider_unavailable", responseStatus));
  }
  return Option.none();
};

type KapsoDeliveryMode = "bsuid" | "sandbox-phone";
type KapsoSendInput = Parameters<WhatsAppDelivery["sendText"]>[0];
type KapsoRecipientAddress =
  | Readonly<{ recipient: WhatsAppBusinessScopedUserId }>
  | Readonly<{ to: string }>;

const resolveRecipientAddress = (
  deliveryMode: KapsoDeliveryMode,
  destination: KapsoSendInput["destination"]
): Effect.Effect<KapsoRecipientAddress, WhatsAppSendFailed> =>
  deliveryMode === "bsuid"
    ? Effect.succeed({ recipient: destination.recipient })
    : Option.match(destination.sandboxPhone, {
        onNone: () => Effect.fail(rejected("invalid_recipient")),
        onSome: (phoneNumber) => Effect.succeed({ to: phoneNumber.slice(1) }),
      });

const encodeTextMessage = (
  address: KapsoRecipientAddress,
  text: TranscriptText,
  opaqueCallbackData: Option.Option<
    DisclosureDeliveryCorrelationToken | HostedDeliveryCorrelationToken
  >
): Effect.Effect<string> =>
  Schema.encodeEffect(UnknownJsonString)({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...address,
    type: "text",
    text: { body: text },
    ...Option.match(opaqueCallbackData, {
      onNone: () => ({}),
      onSome: (value) => ({ biz_opaque_callback_data: value }),
    }),
  }).pipe(Effect.orDie);

const classifyTransportError = (error: KapsoInvalidResponse): WhatsAppSendFailed =>
  error.deliveryCertainty === "rejected"
    ? rejected("invalid_response", false, error.responseStatus)
    : ambiguous("invalid_response", error.responseStatus);

const mapExternalKapsoFailure = (failure: OutboundHttpFailure): WhatsAppSendFailed => {
  if (failure.reason === "transport-failed") return ambiguous("provider_unavailable");
  const responseStatus = Option.flatMap(
    failure.responseStatus,
    Schema.decodeOption(TelemetryHttpStatus)
  );
  const deliveryCertainty = Option.exists(responseStatus, isSuccessfulStatus)
    ? "ambiguous"
    : "rejected";
  return classifyTransportError(invalidKapsoResponse(responseStatus, deliveryCertainty));
};

const decodeSentMessage = (
  responseBody: unknown,
  responseStatus: TelemetryHttpStatus
): Effect.Effect<WhatsAppSentMessage, WhatsAppSendFailed> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(SendResponse)(responseBody).pipe(
      Effect.mapError(() => ambiguous("invalid_response", Option.some(responseStatus)))
    );
    return {
      messageEvidence: {
        channel: "whatsapp",
        provider: "kapso",
        providerMessageId: decoded.messages[0].id,
      },
      sentAt: yield* DateTime.now,
      responseStatus,
    } satisfies WhatsAppSentMessage;
  });

/** Builds a client that routes recipients by delivery mode and reports closed evidence or failures. */
export const makeWhatsAppDelivery = ({
  deliveryMode,
  outboundHttp,
}: Readonly<{
  deliveryMode: KapsoDeliveryMode;
  outboundHttp: OutboundHttpService;
}>): WhatsAppDelivery => {
  const sendText = Effect.fn("Kapso.sendText")(function* (input: KapsoSendInput) {
    const address = yield* resolveRecipientAddress(deliveryMode, input.destination);
    const body = yield* encodeTextMessage(address, input.text, input.opaqueCallbackData);
    return yield* sendKapsoMessage({
      outboundHttp,
      businessPhoneNumberId: input.businessPhoneNumberId,
      body,
    });
  });
  return KapsoClient.of({ sendText });
};

/** Execute exactly one bounded provider mutation; no transport failure permits blind retry. */
export const sendKapsoMessage = ({
  outboundHttp,
  businessPhoneNumberId,
  body,
}: Readonly<{
  outboundHttp: OutboundHttpService;
  businessPhoneNumberId: KapsoSendInput["businessPhoneNumberId"];
  body: string;
}>): Effect.Effect<WhatsAppSentMessage, WhatsAppSendFailed> =>
  Effect.gen(function* () {
    const response = yield* outboundHttp
      .execute({ _tag: "KapsoMessages", businessPhoneNumberId, body })
      .pipe(Effect.mapError(mapExternalKapsoFailure));
    const decodedStatus = Schema.decodeOption(TelemetryHttpStatus)(response.status);
    const responseText = new TextDecoder().decode(response.body);
    if (Option.isNone(decodedStatus)) return yield* rejected("invalid_response");
    const responseStatus = decodedStatus.value;
    const statusFailure = classifyHttpStatus(responseStatus);
    if (Option.isSome(statusFailure)) return yield* statusFailure.value;
    const responseBody = yield* Schema.decodeEffect(UnknownJsonString)(responseText).pipe(
      Effect.mapError(() =>
        isSuccessfulStatus(response.status)
          ? ambiguous("invalid_response", Option.some(responseStatus))
          : rejected("invalid_response", false, Option.some(responseStatus))
      )
    );
    if (!isSuccessfulStatus(response.status)) {
      return yield* classifyFailureBody(responseBody, responseStatus);
    }
    return yield* decodeSentMessage(responseBody, responseStatus);
  }).pipe(
    Effect.timeoutOrElse({
      duration: `${kapsoRequestTimeoutMilliseconds} millis`,
      orElse: () => Effect.fail(ambiguous("timeout")),
    })
  );

/** True-external seam for authorized WhatsApp text delivery. */
export class KapsoClient extends Context.Service<KapsoClient, WhatsAppDelivery>()(
  "@fidy/server/shell/channels/whatsapp/internal/kapso-client/KapsoClient"
) {
  /**
   * WHATSAPP_DELIVERY_MODE defaults to BSUID delivery and permits explicit sandbox phone routing.
   * Calls fail within 15 seconds, reject invalid provider responses, and never persist channel state.
   */
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const outboundHttp = yield* OutboundHttp;
      const deliveryMode = yield* Config.Literals(
        ["bsuid", "sandbox-phone"],
        "WHATSAPP_DELIVERY_MODE"
      ).pipe(Config.withDefault("bsuid"));
      return makeWhatsAppDelivery({ deliveryMode, outboundHttp });
    })
  );
}
