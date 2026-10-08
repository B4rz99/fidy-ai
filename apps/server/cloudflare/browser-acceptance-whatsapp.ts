import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { type Cause, Clock, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { currentDisclosureFor } from "../src/shell/consent/operations";
import { newId } from "./secret-material/operations";
import { db } from "./browser-acceptance-seed";

const digestLength = 64;
const beforeInitiationMs = 10000;
const beforeDisclosureMs = 9000;
const beforeDecisionMs = 8000;
const beforeAcceptanceMs = 7000;
const dayMs = 86400000;
const handoffMs = 600000;
const secondMs = 1000;
const hexRadix = 16;
const HTTP_OK = 200;
const outbound = new Map<string, Readonly<{ text: string; id: string }>>();
const Packet = Schema.Struct({
  recipient: Schema.String,
  text: Schema.Struct({ body: Schema.String }),
});
/** Substitute only Kapso's external delivery; native ingress and D1 remain real. */
export const captureWhatsApp = (request: Request): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const packet = yield* Schema.decodeUnknownEffect(Packet)(
        yield* Effect.tryPromise(() => request.json())
      );
      const id = `wamid.${newId()}`;
      outbound.set(packet.recipient, { text: packet.text.body, id });
      return Response.json({ messaging_product: "whatsapp", messages: [{ id }] });
    })
  );
const seedHandoff = (
  caller: string
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const id = newId();
    const disclosure = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      currentDisclosureFor()
    );
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            `INSERT INTO pending_consent_exchanges(id,portfolio_id,bsuid,phone_number_id,initiating_message_id,initiating_body_sha256,correlation_token,disclosure_json,disclosure_message_id,created_at_ms,disclosed_at_ms,decision_not_before_ms,expires_at_ms,state) VALUES(?,'portfolio',?,'123456789012345',?,? ,?,?, 'disclosure',?,?,?,?,'awaiting_decision')`
          )
          .bind(
            id,
            caller,
            id,
            "a".repeat(digestLength),
            id,
            disclosure,
            now - beforeInitiationMs,
            now - beforeDisclosureMs,
            now - beforeDecisionMs,
            now - beforeInitiationMs + dayMs
          ),
        db
          .prepare(
            `INSERT INTO pending_consent_decisions(exchange_id,portfolio_id,bsuid,phone_number_id,decision,disclosure_json,disclosure_message_id,decision_message_id,delivery_key,body_sha256,occurred_at_ms,received_at_ms) VALUES(?,'portfolio',?,'123456789012345','accepted',?,'disclosure',?,?,?, ?,?)`
          )
          .bind(
            id,
            caller,
            disclosure,
            `${id}.accepted`,
            id,
            "a".repeat(digestLength),
            now - beforeAcceptanceMs,
            now - beforeAcceptanceMs
          ),
        db
          .prepare(
            `INSERT INTO whatsapp_provider_handoffs(id,exchange_id,created_at_ms,expires_at_ms,handoff_send_started_ms) VALUES(?,?,?,?,?)`
          )
          .bind(id, id, now, now + handoffMs, now),
      ])
    );
    return Response.json({ handoffReference: id });
  });
const loopbackFetch: typeof globalThis.fetch = Object.assign(
  (
    input: Parameters<typeof globalThis.fetch>[0],
    init: Parameters<typeof globalThis.fetch>[1]
  ): Promise<Response> => Bun.fetch(input, { ...init, tls: { rejectUnauthorized: false } }),
  { preconnect: Bun.fetch.preconnect }
);
const nativeRuntime = ManagedRuntime.make(
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, loopbackFetch)))
);
const sendNative = (url: string, init: RequestInit): Promise<Response> =>
  nativeRuntime.runPromise(
    HttpClient.execute(HttpClientRequest.fromWeb(new Request(url, init))).pipe(
      Effect.flatMap((response) =>
        response.text.pipe(Effect.map((body) => new Response(body, { status: response.status })))
      )
    )
  );
const sendText = (
  input: Readonly<{ caller: string; text: string; reply: Option.Option<string> }>
): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      message: {
        id: newId(),
        timestamp: String(Math.floor(now / secondMs)),
        type: "text",
        from_user_id: input.caller,
        text: { body: input.text },
        ...Option.match(input.reply, { onNone: () => ({}), onSome: (id) => ({ context: { id } }) }),
      },
      conversation: { business_scoped_user_id: input.caller },
      phone_number_id: "123456789012345",
    });
    const key = yield* Effect.tryPromise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("acceptance-kapso-secret"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
    );
    const signed = yield* Effect.tryPromise(() =>
      crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    );
    const signature = Array.from(new Uint8Array(signed), (byte) =>
      byte.toString(hexRadix).padStart(2, "0")
    ).join("");
    return yield* Effect.tryPromise(() =>
      sendNative("https://127.0.0.1:4174/providers/kapso/callback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": signature,
          "x-webhook-event": "whatsapp.message.received",
          "x-idempotency-key": newId(),
        },
        body,
      })
    );
  });
const review = (caller: string): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const result = yield* sendText({ caller, text: "Estado", reply: Option.none() });
    if (result.status !== HTTP_OK) return result;
    const sent = outbound.get(caller);
    if (sent === undefined) return new Response(null, { status: 503 });
    const code = /asociación ([0-9a-f-]{36})/u.exec(sent.text)?.[1];
    return Response.json({ associationCode: code, reviewMessageId: sent.id });
  });
/** Loopback-only browser driver exchanges public association review material; never browser verifiers or recovery. */
export const whatsappOperator = (request: Request): Option.Option<Promise<Response>> => {
  const url = new URL(request.url);
  const recognized = request.method === "POST" && url.pathname.startsWith("/whatsapp/");
  if (!recognized) return Option.none();
  const caller = url.searchParams.get("caller") ?? "";
  if (!/^CO\.[A-Za-z0-9]{1,64}$/u.test(caller)) {
    return Option.some(Promise.resolve(new Response(null, { status: 400 })));
  }
  if (url.pathname === "/whatsapp/start") {
    return Option.some(Effect.runPromise(seedHandoff(caller)));
  }
  if (url.pathname === "/whatsapp/review") return Option.some(Effect.runPromise(review(caller)));
  if (url.pathname === "/whatsapp/confirm") return Option.some(confirmReview({ caller, url }));
  return Option.some(Promise.resolve(new Response(null, { status: 404 })));
};

const confirmReview = ({
  caller,
  url,
}: Readonly<{ caller: string; url: URL }>): Promise<Response> =>
  Effect.runPromise(
    sendText({
      caller,
      text: `Confirmo asociación ${url.searchParams.get("code") ?? ""}`,
      reply: Option.fromNullOr(url.searchParams.get("reply")),
    })
  );
