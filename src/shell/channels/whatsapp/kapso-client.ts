import { Config, Context, Data, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import type { E164PhoneNumber, WhatsAppBusinessScopedUserId } from "~/core/identity/reference";
import type { TranscriptText } from "~/core/transcript/model";
import type {
  DisclosureDeliveryCorrelationToken,
  DisclosureDeliveryFailureReason,
} from "./disclosure-model";
import { classifyKapsoMetaFailureCode } from "./kapso-failure";
import {
  firstServerErrorStatus,
  forbiddenStatus,
  lastServerErrorStatus,
  requestTimeoutStatus,
  tooManyRequestsStatus,
  unauthorizedStatus,
} from "~/shell/_shared/http-status";
import { TelemetryHttpStatus } from "~/shell/observability/protocol";
import { makeBoundedBytes } from "./bounded-bytes";
import {
  type WhatsAppBusinessPhoneNumberId,
  type WhatsAppInboundEvent,
  type WhatsAppMessageEvidence,
  WhatsAppProviderMessageId,
} from "./model";

/** Whether a provider response proves rejection or acceptance may already have occurred. */
export type KapsoDeliveryCertainty = "rejected" | "ambiguous";

/**
 * Safe provider-send failure. Automatic retry is permitted only when the provider definitively
 * rejected a transient attempt. responseStatus is present exactly when Kapso returned a validated
 * bounded HTTP status, including malformed response bodies, and absent for transport or timeout
 * failures. The value contains no request input, credential, or response body.
 */
export class KapsoSendFailed extends Data.TaggedError("KapsoSendFailed")<{
  readonly safeReason: DisclosureDeliveryFailureReason;
  readonly deliveryCertainty: KapsoDeliveryCertainty;
  readonly automaticRetry: boolean;
  readonly responseStatus: Option.Option<TelemetryHttpStatus>;
}> {
  override get message(): string {
    return `Kapso send failed: ${this.safeReason} (${this.deliveryCertainty})`;
  }
}

/** Decoded provider evidence plus Fidy's local clock time after the response was validated. */
export type KapsoSentMessage = Readonly<{
  readonly messageEvidence: WhatsAppMessageEvidence;
  readonly sentAt: DateTime.Utc;
  readonly responseStatus: TelemetryHttpStatus;
}>;

/** Provider-addressable destination derived only from authenticated WhatsApp caller evidence. */
export type KapsoDestination = Readonly<{
  readonly recipient: WhatsAppBusinessScopedUserId;
  readonly sandboxPhone: Option.Option<E164PhoneNumber>;
}>;

/** Derives provider routing only from the authenticated inbound caller capability. */
export const kapsoDestinationFor = (caller: WhatsAppInboundEvent["caller"]): KapsoDestination => ({
  recipient: caller.businessScopedUserId,
  sandboxPhone: caller.phoneNumber,
});

/**
 * Kapso seam for outbound WhatsApp text. Normal delivery uses the authenticated portfolio-scoped
 * BSUID; explicit sandbox mode uses optional provider-observed phone evidence because Kapso rejects
 * BSUID recipients for sandbox numbers. Failures expose no remote or credential details.
 */
export type KapsoClientService = {
  readonly sendText: (input: {
    readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
    readonly destination: KapsoDestination;
    readonly text: TranscriptText;
    /** Opaque disclosure-attempt correlation forwarded unchanged to lifecycle webhooks. */
    readonly opaqueCallbackData: Option.Option<DisclosureDeliveryCorrelationToken>;
  }) => Effect.Effect<KapsoSentMessage, KapsoSendFailed>;
};

const bytesPerKibibyte = 1_024;
const maximumKapsoResponseKibibytes = 64;
const maximumKapsoResponseBytes = maximumKapsoResponseKibibytes * bytesPerKibibyte;
const kapsoRequestTimeoutMilliseconds = 14_000;

type KapsoFetch = typeof globalThis.fetch;

class KapsoTransportFailure extends Data.TaggedError("KapsoTransportFailure")<{
  readonly timedOut: boolean;
}> {}
class KapsoInvalidResponse extends Data.TaggedError("KapsoInvalidResponse")<{
  readonly deliveryCertainty: KapsoDeliveryCertainty;
  readonly responseStatus: Option.Option<TelemetryHttpStatus>;
}> {}

const rejected = (
  safeReason: DisclosureDeliveryFailureReason,
  automaticRetry = false,
  responseStatus: Option.Option<TelemetryHttpStatus> = Option.none()
): KapsoSendFailed =>
  new KapsoSendFailed({
    safeReason,
    deliveryCertainty: "rejected",
    automaticRetry,
    responseStatus,
  });

const ambiguous = (
  safeReason: DisclosureDeliveryFailureReason,
  responseStatus: Option.Option<TelemetryHttpStatus> = Option.none()
): KapsoSendFailed =>
  new KapsoSendFailed({
    safeReason,
    deliveryCertainty: "ambiguous",
    automaticRetry: false,
    responseStatus,
  });

type ByteReadResult =
  | { readonly done: true }
  | { readonly done: false; readonly value: Uint8Array };

const boundKapsoResponse = (response: Response): Promise<Response> => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximumKapsoResponseBytes) {
    return (response.body?.cancel() ?? Promise.resolve()).then(() =>
      Promise.reject(
        new KapsoInvalidResponse({
          deliveryCertainty: response.ok ? "ambiguous" : "rejected",
          responseStatus: Schema.decodeUnknownOption(TelemetryHttpStatus)(response.status),
        })
      )
    );
  }
  if (response.body === null) return Promise.resolve(response);
  const reader = response.body.getReader();
  const bytes = makeBoundedBytes(maximumKapsoResponseBytes);
  const readNext = (): Promise<Response> => {
    const nextResult: Promise<ByteReadResult> = reader.read();
    return nextResult.then((next) => {
      if (next.done) {
        return new Response(bytes.materialize(), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      if (!bytes.append(next.value)) {
        return reader.cancel().then(() =>
          Promise.reject(
            new KapsoInvalidResponse({
              deliveryCertainty: response.ok ? "ambiguous" : "rejected",
              responseStatus: Schema.decodeUnknownOption(TelemetryHttpStatus)(response.status),
            })
          )
        );
      }
      return readNext();
    });
  };
  return readNext();
};

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
): KapsoSendFailed => {
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

const classifyHttpStatus = (status: TelemetryHttpStatus): Option.Option<KapsoSendFailed> => {
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
type KapsoSendInput = Parameters<KapsoClientService["sendText"]>[0];
type KapsoRecipientAddress =
  | Readonly<{ recipient: WhatsAppBusinessScopedUserId }>
  | Readonly<{ to: string }>;

const boundedKapsoFetch = (nativeFetch: KapsoFetch): KapsoFetch =>
  Object.assign(
    (resource: Parameters<KapsoFetch>[0], init?: Parameters<KapsoFetch>[1]) => {
      const timeout = AbortSignal.timeout(kapsoRequestTimeoutMilliseconds);
      const signal =
        init?.signal !== undefined && init.signal !== null
          ? AbortSignal.any([init.signal, timeout])
          : timeout;
      return nativeFetch(resource, { ...init, signal })
        .catch((error: unknown) =>
          Promise.reject(
            new KapsoTransportFailure({
              timedOut:
                error instanceof DOMException &&
                ["TimeoutError", "AbortError"].includes(error.name),
            })
          )
        )
        .then(boundKapsoResponse);
    },
    { preconnect: nativeFetch.preconnect }
  );

const resolveRecipientAddress = (
  deliveryMode: KapsoDeliveryMode,
  destination: KapsoSendInput["destination"]
): Effect.Effect<KapsoRecipientAddress, KapsoSendFailed> =>
  deliveryMode === "bsuid"
    ? Effect.succeed({ recipient: destination.recipient })
    : Option.match(destination.sandboxPhone, {
        onNone: () => Effect.fail(rejected("invalid_recipient")),
        onSome: (phoneNumber) => Effect.succeed({ to: phoneNumber.slice(1) }),
      });

const encodeTextMessage = (
  address: KapsoRecipientAddress,
  text: TranscriptText,
  opaqueCallbackData: Option.Option<DisclosureDeliveryCorrelationToken>
): Effect.Effect<string> =>
  Schema.encodeEffect(Schema.UnknownFromJsonString)({
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

const classifyTransportError = (error: unknown): KapsoSendFailed => {
  if (error instanceof KapsoTransportFailure) {
    return ambiguous(error.timedOut ? "timeout" : "provider_unavailable");
  }
  if (error instanceof KapsoInvalidResponse) {
    return error.deliveryCertainty === "rejected"
      ? rejected("invalid_response", false, error.responseStatus)
      : ambiguous("invalid_response", error.responseStatus);
  }
  return ambiguous("invalid_response");
};

const decodeSentMessage = (
  responseBody: unknown,
  responseStatus: TelemetryHttpStatus
): Effect.Effect<KapsoSentMessage, KapsoSendFailed> =>
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
    } satisfies KapsoSentMessage;
  });

/** Constructs the bounded, authenticated Kapso adapter for outbound WhatsApp delivery. */
export const makeKapsoClientService = ({
  apiKey,
  deliveryMode,
  nativeFetch,
}: Readonly<{
  apiKey: string;
  deliveryMode: KapsoDeliveryMode;
  nativeFetch: KapsoFetch;
}>): KapsoClientService => {
  const boundedFetch = boundedKapsoFetch(nativeFetch);
  const postMessage = (
    input: KapsoSendInput,
    body: string
  ): Effect.Effect<Response, KapsoSendFailed> =>
    Effect.tryPromise({
      try: (signal) =>
        boundedFetch(
          `https://api.kapso.ai/meta/whatsapp/v24.0/${input.businessPhoneNumberId}/messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": apiKey },
            body,
            signal,
          }
        ),
      catch: classifyTransportError,
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.catchTag("TimeoutError", () => Effect.fail(ambiguous("timeout")))
    );
  return KapsoClient.of({
    sendText: Effect.fn("Kapso.sendText")(function* (input) {
      const address = yield* resolveRecipientAddress(deliveryMode, input.destination);
      const body = yield* encodeTextMessage(address, input.text, input.opaqueCallbackData);
      const response = yield* postMessage(input, body);
      const decodedStatus = Schema.decodeUnknownOption(TelemetryHttpStatus)(response.status);
      if (Option.isNone(decodedStatus)) return yield* rejected("invalid_response");
      const responseStatus = decodedStatus.value;
      const statusFailure = classifyHttpStatus(responseStatus);
      if (Option.isSome(statusFailure)) return yield* statusFailure.value;
      const responseBody = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () =>
          response.ok
            ? ambiguous("invalid_response", Option.some(responseStatus))
            : rejected("invalid_response", false, Option.some(responseStatus)),
      });
      if (!response.ok) return yield* classifyFailureBody(responseBody, responseStatus);
      return yield* decodeSentMessage(responseBody, responseStatus);
    }),
  });
};

/** True-external seam for authorized WhatsApp text delivery. */
export class KapsoClient extends Context.Service<KapsoClient, KapsoClientService>()(
  "fidy-ai/shell/channels/whatsapp/kapso-client/KapsoClient"
) {
  /**
   * Provides authenticated Kapso text delivery from KAPSO_API_KEY. WHATSAPP_DELIVERY_MODE defaults
   * to BSUID delivery and permits explicit sandbox phone routing. Calls fail within 15 seconds,
   * reject invalid provider responses, and never persist channel state.
   */
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("KAPSO_API_KEY");
      const deliveryMode = yield* Config.literals(
        ["bsuid", "sandbox-phone"],
        "WHATSAPP_DELIVERY_MODE"
      ).pipe(Config.withDefault("bsuid"));
      return makeKapsoClientService({
        apiKey: Redacted.value(apiKey),
        deliveryMode,
        nativeFetch: globalThis["fetch"],
      });
    })
  );
}
