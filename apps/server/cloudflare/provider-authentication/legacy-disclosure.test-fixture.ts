import {
  type Cause,
  Clock,
  type Crypto,
  DateTime,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { makeConsentIngress } from "../consent/ingress/runtime";
import { OutboundHttpLive } from "../outbound-http/runtime";
import { authenticateWhatsAppInbound } from "../../src/shell/channels/whatsapp/operations";
import { Sha256Digest } from "../../src/shell/consent/contract";
import type { WhatsAppInboundEvent } from "../../src/shell/channels/whatsapp/contract";
import { TestCrypto } from "../../src/shell/testing/crypto-harness";
import { newId } from "../secret-material/operations";
import type { Journey } from "./journey.test-fixture";

const successStatus = 200;
const unavailableStatus = 503;
const invitationLifetimeMs = 600000;
const millisecondsPerSecond = 1000;
const hexadecimalRadix = 16;
const Json = Schema.fromJsonString(Schema.Unknown);
type LegacyRequest = Readonly<{
  db: D1Database;
  rawBody: Uint8Array;
  signature: string;
  secret: string;
  portfolio: string;
  sandboxPhoneNumberId: string;
  deliveryKey: string;
  native: () => Promise<Response>;
}>;
const seedLegacyInvitation = (
  input: LegacyRequest,
  event: WhatsAppInboundEvent,
  { current, id }: Readonly<{ current: number; id: string }>
): Promise<D1Result> =>
  input.db
    .prepare(`INSERT INTO whatsapp_signup_invitations(id,source_portfolio_id,source_bsuid,source_phone_number_id,source_message_id,created_at_ms,expires_at_ms)
 SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM whatsapp_signup_invitations WHERE source_portfolio_id=? AND source_bsuid=? AND expires_at_ms>?)`)
    .bind(
      id,
      event.caller.businessPortfolioId,
      event.caller.businessScopedUserId,
      event.businessPhoneNumberId,
      event.messageEvidence.providerMessageId,
      current,
      current + invitationLifetimeMs,
      event.caller.businessPortfolioId,
      event.caller.businessScopedUserId,
      current
    )
    .run();

const findLegacyExchange = (
  input: LegacyRequest,
  event: WhatsAppInboundEvent,
  current: number
): Promise<unknown> =>
  input.db
    .prepare(
      "SELECT id FROM pending_consent_exchanges WHERE portfolio_id=? AND bsuid=? AND phone_number_id=? AND expires_at_ms>? LIMIT 1"
    )
    .bind(
      event.caller.businessPortfolioId,
      event.caller.businessScopedUserId,
      event.businessPhoneNumberId,
      current
    )
    .first();
const legacyConsent = (
  input: LegacyRequest
): Effect.Effect<
  Response,
  Cause.UnknownError | Schema.SchemaError | void,
  Crypto.Crypto | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const authenticated = yield* authenticateWhatsAppInbound({
      rawBody: input.rawBody,
      secret: Redacted.make(input.secret),
      signature: input.signature,
      deliveryKey: input.deliveryKey,
      businessPortfolioId: input.portfolio,
      receivedAt: DateTime.makeUnsafe(current),
    }).pipe(Effect.option);
    if (Option.isNone(authenticated)) return yield* Effect.tryPromise(input.native);
    const event = authenticated.value.events[0];
    if (event.content._tag !== "Text") return yield* Effect.tryPromise(input.native);
    const pending = yield* Effect.tryPromise(() => findLegacyExchange(input, event, current));
    const invitationId = newId();
    if (pending === null) {
      yield* Effect.tryPromise(() =>
        seedLegacyInvitation(input, event, { current, id: invitationId })
      );
    }

    const native = yield* Effect.tryPromise(input.native);
    yield* Effect.tryPromise(() =>
      input.db
        .prepare("DELETE FROM whatsapp_signup_invitations WHERE id=?")
        .bind(invitationId)
        .run()
    );
    if (pending !== null || native.status !== successStatus) return native;
    const digest = yield* Schema.decodeEffect(Sha256Digest)(
      new Bun.CryptoHasher("sha256").update(input.rawBody).digest("hex")
    );
    return yield* makeConsentIngress({
      environment: {
        DB: input.db,
        KAPSO_API_KEY: "test-kapso-key",
        WHATSAPP_SANDBOX_PHONE_NUMBER_ID: input.sandboxPhoneNumberId,
      },
      httpClient: yield* HttpClient.HttpClient,
    })({
      event: { ...event, content: event.content },
      deliveryKey: authenticated.value.deliveryKey,
      digest,
      receivedAtMs: current,
    });
  });

const legacyRuntime = ManagedRuntime.make(Layer.mergeAll(OutboundHttpLive, TestCrypto));
export const disposeLegacyConsent = (): Promise<void> => legacyRuntime.dispose();

/** Rehearse an already-issued chat disclosure through its owner while preserving native ingress replay admission. */
export const receiveLegacyConsent = (input: LegacyRequest): Promise<Response> =>
  legacyRuntime.runPromise(
    Effect.scoped(legacyConsent(input)).pipe(
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      Effect.orElseSucceed(() => new Response(null, { status: unavailableStatus }))
    )
  );

type GreetingOptions = Partial<
  Readonly<{ caller: string; phone: string; message: string; timestamp: number }>
>;
const legacyBody = (text: string, options: GreetingOptions, current: number): unknown => ({
  message: {
    id: options.message ?? newId(),
    timestamp: String(options.timestamp ?? Math.floor(current / millisecondsPerSecond)),
    type: "text",
    from_user_id: options.caller ?? "CO.Person1",
    ...(options.phone === undefined ? {} : { from: options.phone }),
    text: { body: text },
  },
  conversation: { business_scoped_user_id: options.caller ?? "CO.Person1" },
  phone_number_id: "123456789012345",
});
const signBody = (body: Uint8Array): Promise<string> =>
  crypto.subtle
    .importKey(
      "raw",
      new TextEncoder().encode("test-kapso-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    )
    .then((key) => crypto.subtle.sign("HMAC", key, new Uint8Array(body)))
    .then((bytes) =>
      Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(hexadecimalRadix).padStart(2, "0")
      ).join("")
    );
export const discloseLegacyChat = Effect.fn(function* (
  journey: Journey,
  text: string,
  options: GreetingOptions = {}
): Effect.fn.Return<Response, Cause.UnknownError | Schema.SchemaError> {
  const body = legacyBody(text, options, yield* Clock.currentTimeMillis);
  const rawBody = new TextEncoder().encode(yield* Schema.encodeEffect(Json)(body));
  const signature = yield* Effect.tryPromise(() => signBody(rawBody));
  return yield* Effect.tryPromise(() =>
    receiveLegacyConsent({
      db: journey.db,
      rawBody,
      signature,
      secret: "test-kapso-secret",
      portfolio: "portfolio",
      sandboxPhoneNumberId: journey.sandboxPhoneNumberId,
      deliveryKey: "delivery",
      native: () =>
        journey.send("/providers/kapso/callback", body, {
          "x-webhook-signature": signature,
          "x-webhook-event": "whatsapp.message.received",
          "x-idempotency-key": "delivery",
        }),
    })
  );
});
