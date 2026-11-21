import {
  type ExternalEventBindings,
  StatusLookupCoordinates,
  directoryName,
  statusLookupAdmissionUrl,
} from "../../directory/contract";
import {
  type WhatsAppStatusLookupAdmission,
  WhatsAppStatusUnavailable,
} from "../../../src/shell/channels/whatsapp/contract";
import { Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import {
  DeliverySend,
  SendReply,
  WhatsAppUnavailable,
  claimDeliveryUrl,
  replyDeliveryUrl,
  reserveDeliveryUrl,
} from "../contract";

const claimedStatus = 201;

export type SendPreparation = Omit<typeof DeliverySend.Type, "contentDigest"> & {
  content: unknown;
};

export const claimRegisteredSend = Effect.fn(
  function* (environment: Partial<ExternalEventBindings>, input: SendPreparation) {
    const owners = environment.USER_STORE;

    if (owners === undefined) return yield* new WhatsAppUnavailable({ cause: Option.none() });
    const { content, ...binding } = input;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(content);

    const digest = yield* Effect.tryPromise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded))
    );

    const body = yield* Schema.encodeEffect(Schema.fromJsonString(DeliverySend))({
      ...binding,
      contentDigest: Hex.encode(new Uint8Array(digest)),
    });

    const user = owners.getByName(binding.userId);

    const call = (url: string): Effect.Effect<Response, WhatsAppUnavailable> =>
      Effect.tryPromise((signal) => user.fetch(url, { method: "POST", body, signal })).pipe(
        Effect.mapError((cause) => new WhatsAppUnavailable({ cause: Option.some(cause) }))
      );

    const reserved = yield* call(reserveDeliveryUrl);

    if (!reserved.ok) return yield* new WhatsAppUnavailable({ cause: Option.none() });

    return {
      claim: Effect.gen(function* () {
        const reply = yield* call(claimDeliveryUrl);

        if (reply.status !== claimedStatus) {
          return yield* new WhatsAppUnavailable({ cause: Option.none() });
        }
      }),
    };
  },
  Effect.mapError((cause) => new WhatsAppUnavailable({ cause: Option.some(cause) }))
);

export const recordRegisteredSend = Effect.fn(
  function* (environment: Partial<ExternalEventBindings>, result: typeof SendReply.Type) {
    const owners = environment.USER_STORE;

    if (owners === undefined) return yield* new WhatsAppUnavailable({ cause: Option.none() });
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(SendReply))(result);

    const reply = yield* Effect.tryPromise((signal) =>
      owners.getByName(result.userId).fetch(replyDeliveryUrl, { method: "POST", body, signal })
    );

    if (!reply.ok) return yield* new WhatsAppUnavailable({ cause: Option.none() });
  },
  Effect.mapError((cause) => new WhatsAppUnavailable({ cause: Option.some(cause) }))
);

export const nativeStatusAdmission =
  (env: Partial<ExternalEventBindings>): WhatsAppStatusLookupAdmission =>
  (input) =>
    Effect.gen(function* () {
      if (env.DIRECTORY === undefined) {
        return yield* new WhatsAppStatusUnavailable({ cause: undefined });
      }

      const body = yield* Schema.encodeEffect(Schema.fromJsonString(StatusLookupCoordinates))({
        endpoint: input.businessPhoneNumberId,
        messageId: input.messageId,
        status: input.status,
      });

      const owner = env.DIRECTORY.getByName(directoryName);

      const reply = yield* Effect.tryPromise((signal) =>
        owner.fetch(statusLookupAdmissionUrl, { method: "POST", body, signal })
      );

      if (!reply.ok) return yield* new WhatsAppStatusUnavailable({ cause: undefined });
    }).pipe(Effect.mapError((cause) => new WhatsAppStatusUnavailable({ cause })));
