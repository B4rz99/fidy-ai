import { type Cause, Clock, Effect, Option, Schema } from "effect";
import { newId } from "../secret-material/operations";
import type { setup } from "./journey.test-fixture";

const sendPacket = (
  journey: Awaited<ReturnType<typeof setup>>,
  body: unknown,
  options: Readonly<{ signature: Option.Option<string>; event: string }>
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body)
    );
    const key = yield* Effect.tryPromise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("test-kapso-secret"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
    );
    const signed = yield* Effect.tryPromise(() => crypto.subtle.sign("HMAC", key, bytes));
    const signature = Array.from(new Uint8Array(signed), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    return yield* Effect.tryPromise(() =>
      journey.send("/providers/kapso/callback", body, {
        "x-webhook-signature": Option.getOrElse(options.signature, () => signature),
        "x-webhook-event": options.event,
        "x-idempotency-key": "delivery",
      })
    );
  });
const sendChat = (
  journey: Awaited<ReturnType<typeof setup>>,
  text: string,
  options: Partial<
    Readonly<{
      caller: string;
      reply: string;
      signature: string;
      message: string;
      timestamp: number;
      phone: string;
    }>
  > = {}
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const messageId = newId();
    const body = {
      message: {
        id: options.message ?? messageId,
        timestamp: String(options.timestamp ?? Math.floor(now / 1000)),
        type: "text",
        from_user_id: options.caller ?? "CO.Person1",
        ...(options.phone === undefined ? {} : { from: options.phone }),
        text: { body: text },
        ...(options.reply === undefined ? {} : { context: { id: options.reply } }),
      },
      conversation: { business_scoped_user_id: options.caller ?? "CO.Person1" },
      phone_number_id: "123456789012345",
    };
    return yield* sendPacket(journey, body, {
      signature: Option.fromUndefinedOr(options.signature),
      event: "whatsapp.message.received",
    });
  });

export const whatsappMessages = { sendPacket, sendChat };
