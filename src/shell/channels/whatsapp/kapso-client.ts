import { Config, Context, Data, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import type { E164PhoneNumber, WhatsAppBusinessScopedUserId } from "~/core/identity/reference";
import type { TranscriptText } from "~/core/transcript/model";
import { makeBoundedBytes } from "./bounded-bytes";
import {
  type WhatsAppBusinessPhoneNumberId,
  WhatsAppProviderMessageId,
  type WhatsAppMessageEvidence,
} from "./model";

/** Safe provider-send failure that reveals no remote response or credential detail. */
export class KapsoSendFailed extends Data.TaggedError("KapsoSendFailed")<{
  readonly safeReason: "unavailable" | "invalid_response";
}> {}

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

/** True-external Kapso text sender used only after channel policy authorizes a recipient. */
export class KapsoClient extends Context.Service<KapsoClient, KapsoClientService>()(
  "fidy-ai/shell/channels/whatsapp/kapso-client/KapsoClient"
) {}

const maximumKapsoResponseBytes = 64 * 1_024;

type KapsoFetch = typeof globalThis.fetch;

class KapsoTransportFailure extends Data.TaggedError("KapsoTransportFailure")<{}> {}
class KapsoInvalidResponse extends Data.TaggedError("KapsoInvalidResponse")<{}> {}

type ByteReadResult =
  | { readonly done: true; readonly value?: never }
  | { readonly done: false; readonly value: Uint8Array };

const boundKapsoResponse = (response: Response): Promise<Response> => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximumKapsoResponseBytes) {
    return (response.body?.cancel() ?? Promise.resolve()).then(() =>
      Promise.reject(new KapsoInvalidResponse())
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
        return reader.cancel().then(() => Promise.reject(new KapsoInvalidResponse()));
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
  deliveryMode: "bsuid" | "sandbox-phone";
  nativeFetch: KapsoFetch;
}>) => {
  const boundedFetch = Object.assign(
    (resource: Parameters<KapsoFetch>[0], init?: Parameters<KapsoFetch>[1]) => {
      const timeout = AbortSignal.timeout(14_000);
      const signal =
        init?.signal !== undefined && init.signal !== null
          ? AbortSignal.any([init.signal, timeout])
          : timeout;
      return nativeFetch(resource, { ...init, signal })
        .catch(() => Promise.reject(new KapsoTransportFailure()))
        .then(boundKapsoResponse);
    },
    { preconnect: nativeFetch.preconnect }
  );
  return KapsoClient.of({
    sendText: Effect.fn("Kapso.sendText")(function* (input) {
      const address =
        deliveryMode === "bsuid"
          ? { recipient: input.destination.recipient }
          : yield* Option.match(input.destination.sandboxPhone, {
              onNone: () => Effect.fail(new KapsoSendFailed({ safeReason: "invalid_response" })),
              onSome: (phoneNumber) => Effect.succeed({ to: phoneNumber.slice(1) }),
            });
      const body = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...address,
        type: "text",
        text: { body: input.text },
      }).pipe(Effect.orDie);
      const response = yield* Effect.tryPromise({
        try: () =>
          boundedFetch(
            `https://api.kapso.ai/meta/whatsapp/v24.0/${input.businessPhoneNumberId}/messages`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-api-key": apiKey,
              },
              body,
            }
          ).then((result) => {
            if (!result.ok) throw new KapsoInvalidResponse();
            return result.json();
          }),
        catch: (error) =>
          new KapsoSendFailed({
            safeReason: error instanceof KapsoTransportFailure ? "unavailable" : "invalid_response",
          }),
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(new KapsoSendFailed({ safeReason: "unavailable" }))
        )
      );
      const decoded = yield* Schema.decodeUnknownEffect(SendResponse)(response).pipe(
        Effect.mapError(() => new KapsoSendFailed({ safeReason: "invalid_response" }))
      );
      return {
        messageEvidence: {
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: decoded.messages[0].id,
        },
        sentAt: yield* DateTime.now,
      };
    }),
  });
};

/**
 * Provides authenticated Kapso text delivery from KAPSO_API_KEY. WHATSAPP_DELIVERY_MODE defaults
 * to BSUID delivery and permits explicit sandbox phone routing. Calls fail within 15 seconds,
 * reject invalid provider responses, and never persist channel state.
 */
export const KapsoClientLive = Layer.effect(
  KapsoClient,
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
