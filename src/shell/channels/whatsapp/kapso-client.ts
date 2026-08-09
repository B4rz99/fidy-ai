import { Config, Context, Data, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import type { E164PhoneNumber, WhatsAppBusinessScopedUserId } from "~/core/identity/reference";
import type { TranscriptText } from "~/core/transcript/model";
import {
  firstServerErrorStatus,
  forbiddenStatus,
  lastServerErrorStatus,
  requestTimeoutStatus,
  tooManyRequestsStatus,
  unauthorizedStatus,
} from "~/shell/_shared/http-status";
import { makeBoundedBytes } from "./bounded-bytes";
import {
  type WhatsAppBusinessPhoneNumberId,
  type WhatsAppMessageEvidence,
  WhatsAppProviderMessageId,
} from "./model";

/** Closed operator-safe reason for a failed Kapso send. */
export type KapsoFailureReason =
  | "sandbox_bsuid_unsupported"
  | "invalid_recipient"
  | "conversation_window_closed"
  | "rate_limited"
  | "authentication_failed"
  | "provider_unavailable"
  | "timeout"
  | "invalid_response";

/** Whether a provider response proves rejection or acceptance may already have occurred. */
export type KapsoDeliveryCertainty = "rejected" | "ambiguous";

/**
 * Safe provider-send failure. Automatic retry is permitted only when the provider definitively
 * rejected a transient attempt; the value contains no request input, credential, or response body.
 */
export class KapsoSendFailed extends Data.TaggedError("KapsoSendFailed")<{
  readonly safeReason: KapsoFailureReason;
  readonly deliveryCertainty: KapsoDeliveryCertainty;
  readonly automaticRetry: boolean;
}> {
  override get message(): string {
    return `Kapso send failed: ${this.safeReason} (${this.deliveryCertainty})`;
  }
}

/** Decoded provider evidence plus Fidy's local clock time after the response was validated. */
export type KapsoSentMessage = Readonly<{
  readonly messageEvidence: WhatsAppMessageEvidence;
  readonly sentAt: DateTime.Utc;
}>;

/**
 * Sends one validated TranscriptText to the configured Kapso destination. The caller must supply
 * the authenticated portfolio-scoped BSUID and its optional provider-observed phone evidence.
 * Normal delivery uses only the BSUID; explicit sandbox mode uses phone evidence because Kapso
 * rejects BSUID recipients for sandbox numbers. Failures expose no remote or credential details.
 */
export type KapsoClientService = {
  readonly sendText: (input: {
    readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
    readonly destination: {
      readonly recipient: WhatsAppBusinessScopedUserId;
      readonly sandboxPhone: Option.Option<E164PhoneNumber>;
    };
    readonly text: TranscriptText;
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
}> {}

const rejected = (safeReason: KapsoFailureReason, automaticRetry = false): KapsoSendFailed =>
  new KapsoSendFailed({ safeReason, deliveryCertainty: "rejected", automaticRetry });

const ambiguous = (safeReason: KapsoFailureReason): KapsoSendFailed =>
  new KapsoSendFailed({
    safeReason,
    deliveryCertainty: "ambiguous",
    automaticRetry: false,
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

const metaBusinessBlockedRecipientCode = 130_403;
const metaRecipientIsSenderCode = 131_021;
const metaRecipientUndeliverableCode = 131_026;
const metaRecipientStoppedMarketingCode = 131_050;

const metaAppRateLimitCode = 4;
const metaUserRateLimitCode = 17;
const metaPageRateLimitCode = 32;
const metaBusinessAccountRateLimitCode = 80_007;
const metaMessageThroughputLimitCode = 130_429;
const metaRecipientPairRateLimitCode = 131_056;

const metaPermissionDeniedCode = 10;
const metaExpiredAccessTokenCode = 190;
const metaMissingPermissionCode = 200;
const metaAccessDeniedCode = 131_005;

const metaUnknownErrorCode = 1;
const metaTemporaryServiceErrorCode = 2;
const metaUnknownSendFailureCode = 131_000;
const metaServiceUnavailableCode = 131_016;
const metaMaintenanceModeCode = 131_057;
const metaServerTemporarilyUnavailableCode = 133_004;

const metaReengagementWindowCode = 131_047;

const invalidRecipientCodes = new Set([
  metaBusinessBlockedRecipientCode,
  metaRecipientIsSenderCode,
  metaRecipientUndeliverableCode,
  metaRecipientStoppedMarketingCode,
]);
const rateLimitedCodes = new Set([
  metaAppRateLimitCode,
  metaUserRateLimitCode,
  metaPageRateLimitCode,
  metaBusinessAccountRateLimitCode,
  metaMessageThroughputLimitCode,
  metaRecipientPairRateLimitCode,
]);
const authenticationCodes = new Set([
  metaPermissionDeniedCode,
  metaExpiredAccessTokenCode,
  metaMissingPermissionCode,
  metaAccessDeniedCode,
]);
const unavailableCodes = new Set([
  metaUnknownErrorCode,
  metaTemporaryServiceErrorCode,
  metaUnknownSendFailureCode,
  metaServiceUnavailableCode,
  metaMaintenanceModeCode,
  metaServerTemporarilyUnavailableCode,
]);

const classifyMetaCode = (code: number): KapsoSendFailed => {
  if (invalidRecipientCodes.has(code)) return rejected("invalid_recipient");
  if (code === metaReengagementWindowCode) return rejected("conversation_window_closed");
  if (rateLimitedCodes.has(code)) return rejected("rate_limited", true);
  if (authenticationCodes.has(code)) return rejected("authentication_failed");
  if (unavailableCodes.has(code)) return rejected("provider_unavailable", true);
  return rejected("invalid_response");
};

const classifyFailureBody = (body: unknown): KapsoSendFailed => {
  const metaFailure = Schema.decodeUnknownOption(MetaFailureResponse)(body);
  if (Option.isSome(metaFailure)) return classifyMetaCode(metaFailure.value.error.code);
  const kapsoFailure = Schema.decodeUnknownOption(KapsoFailureResponse)(body);
  if (
    Option.isSome(kapsoFailure) &&
    kapsoFailure.value.error.toLowerCase() === "sandbox numbers do not support bsuid recipients"
  ) {
    return rejected("sandbox_bsuid_unsupported");
  }
  return rejected("invalid_response");
};

const classifyHttpStatus = (status: number): Option.Option<KapsoSendFailed> => {
  if (status === unauthorizedStatus || status === forbiddenStatus) {
    return Option.some(rejected("authentication_failed"));
  }
  if (status === requestTimeoutStatus) return Option.some(ambiguous("timeout"));
  if (status === tooManyRequestsStatus) return Option.some(rejected("rate_limited", true));
  if (status >= firstServerErrorStatus && status <= lastServerErrorStatus) {
    return Option.some(ambiguous("provider_unavailable"));
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
  text: TranscriptText
): Effect.Effect<string> =>
  Schema.encodeEffect(Schema.UnknownFromJsonString)({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...address,
    type: "text",
    text: { body: text },
  }).pipe(Effect.orDie);

const classifyTransportError = (error: unknown): KapsoSendFailed => {
  if (error instanceof KapsoTransportFailure) {
    return ambiguous(error.timedOut ? "timeout" : "provider_unavailable");
  }
  if (error instanceof KapsoInvalidResponse) {
    return error.deliveryCertainty === "rejected"
      ? rejected("invalid_response")
      : ambiguous("invalid_response");
  }
  return ambiguous("invalid_response");
};

const decodeSentMessage = (
  responseBody: unknown
): Effect.Effect<KapsoSentMessage, KapsoSendFailed> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(SendResponse)(responseBody).pipe(
      Effect.mapError(() => ambiguous("invalid_response"))
    );
    return {
      messageEvidence: {
        channel: "whatsapp",
        provider: "kapso",
        providerMessageId: decoded.messages[0].id,
      },
      sentAt: yield* DateTime.now,
    } satisfies KapsoSentMessage;
  });

/**
 * Constructs the true-external sender around an explicit transport. Responses larger than 64 KiB
 * are rejected; transport, timeout, oversized, and malformed responses remain safe KapsoSendFailed
 * values.
 */
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
      const body = yield* encodeTextMessage(address, input.text);
      const response = yield* postMessage(input, body);
      const statusFailure = classifyHttpStatus(response.status);
      if (Option.isSome(statusFailure)) return yield* statusFailure.value;
      const responseBody = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => (response.ok ? ambiguous("invalid_response") : rejected("invalid_response")),
      });
      if (!response.ok) return yield* classifyFailureBody(responseBody);
      return yield* decodeSentMessage(responseBody);
    }),
  });
};

/** True-external Kapso text sender used only after channel policy authorizes a recipient. */
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
