import { Clock, Effect, Predicate, Schema } from "effect";
import { Hex } from "effect/encoding";
import type { Miniflare } from "miniflare";
import { newId } from "./secret-material/operations";
import { productionTopology } from "./runtime/contract";
import { native } from "./user-store.test-fixture";

const millisecondsPerSecond = 1000;

type ChatOptions = Partial<
  Readonly<{
    endpoint: string;
    occurredMs: number;
    secret: string;
    phone: string;
    message: string;
    reply: string;
  }>
>;

export const chatWith = Effect.fn(function* (
  runtime: Miniflare,
  { text, caller, ...options }: Readonly<{ text: string; caller: string }> & ChatOptions
) {
  const now = yield* Clock.currentTimeMillis;

  const bytes = new TextEncoder().encode(
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      message: {
        id: options.message ?? newId(),
        context: options.reply === undefined ? undefined : { id: options.reply },
        timestamp: String(Math.floor((options.occurredMs ?? now) / millisecondsPerSecond)),
        type: "text",
        from_user_id: caller,
        from: options.phone ?? "573001234567",
        text: { body: text },
      },
      conversation: { business_scoped_user_id: caller },
      phone_number_id: options.endpoint ?? "123456789012345",
    })
  );

  return yield* signedWebhook(runtime, bytes, options.secret ?? "test-kapso-secret");
});

export const signedWebhook = Effect.fn(function* (
  runtime: Miniflare,
  bytes: Uint8Array<ArrayBuffer>,
  signature: string | Readonly<{ secret: string; event: string }>
) {
  const { secret, event } = Predicate.isString(signature)
    ? { secret: signature, event: "whatsapp.message.received" }
    : signature;

  const key = yield* native(() =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    )
  );

  const digest = yield* native(() => crypto.subtle.sign("HMAC", key, bytes));

  return yield* native(() =>
    runtime.dispatchFetch(
      `https://${productionTopology.ingress.hostname}/providers/kapso/callback`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": Hex.encode(new Uint8Array(digest)),
          "x-webhook-event": event,
          "x-idempotency-key": newId(),
          connection: "close",
        },
        body: bytes,
      }
    )
  );
});

export const signedChat = Effect.fn(function* (runtime: Miniflare, text: string, caller: string) {
  return yield* chatWith(runtime, { text, caller });
});
