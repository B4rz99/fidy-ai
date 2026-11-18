import { type UserStoreBindings, directoryName, whatsappBootstrapUrl } from "../directory/contract";
import { type Digest, type SecureRandom } from "effect/crypto";
import {
  type Cause,
  Clock,
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
import { maxWhatsAppFutureTimestampMinutes } from "../../src/shell/channels/whatsapp/contract";
import { receiveHandoffText } from "./internal/whatsapp-handoff";
import { makeProviderHandoffSender } from "../../src/shell/provider-authentication/runtime";
import { TestCrypto } from "../../src/shell/testing/crypto-harness";
import { newId } from "../secret-material/operations";

export type Journey = Readonly<{
  sandboxPhoneNumberId: string;
  db: D1Database;
  send: (
    path: string,
    body?: unknown,
    headers?: Readonly<Record<string, string>> | Headers
  ) => Promise<Response>;
}>;

const successStatus = 200;
const unavailableStatus = 503;
const dayMilliseconds = 86_400_000;
const minuteMilliseconds = 60_000;
const maximumInitiatingAgeMs =
  dayMilliseconds - maxWhatsAppFutureTimestampMinutes * minuteMilliseconds;
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
const legacyConsent = (
  input: LegacyRequest
): Effect.Effect<
  Response,
  Cause.UnknownError | Schema.SchemaError | void,
  SecureRandom.SecureRandom | Digest.Digest | HttpClient.HttpClient
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
    if (Option.isNone(authenticated) || authenticated.value.events.length !== 1) {
      return yield* Effect.tryPromise(input.native);
    }
    const event = authenticated.value.events[0];
    if (
      event.content._tag !== "Text" ||
      DateTime.toEpochMillis(event.occurredAt) + maximumInitiatingAgeMs <= current
    ) {
      return yield* Effect.tryPromise(input.native);
    }
    const digest = yield* Schema.decodeEffect(Sha256Digest)(
      new Bun.CryptoHasher("sha256").update(input.rawBody).digest("hex")
    );
    const inbound = {
      event: { ...event, content: event.content },
      deliveryKey: authenticated.value.deliveryKey,
      digest,
      receivedAtMs: current,
    };
    const httpClient = yield* HttpClient.HttpClient;
    const consent = yield* makeConsentIngress({
      environment: {
        DB: input.db,
        KAPSO_API_KEY: "test-kapso-key",
        WHATSAPP_SANDBOX_PHONE_NUMBER_ID: input.sandboxPhoneNumberId,
      },
      httpClient,
    })(inbound);
    if (consent.status !== successStatus) return consent;
    const next = yield* receiveHandoffText({
      db: input.db,
      browserOrigin: "https://app.fidyapp.com",
      inbound,
      send: makeProviderHandoffSender({
        httpClient,
        apiKey: Redacted.make("test-kapso-key"),
        sandboxPhoneNumberId: Option.fromNullishOr(input.sandboxPhoneNumberId),
      }),
    });
    return Option.getOrElse(next, () => consent);
  });

const legacyRuntime = ManagedRuntime.make(Layer.mergeAll(OutboundHttpLive, TestCrypto));
export const disposeLegacyConsent = (): Promise<void> => legacyRuntime.dispose();

/** Exercise the retained disclosure and delivery owners with authenticated test messages. */
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

/** Supply an already resolved caller to tests of the downstream hosted Turn. */
export const registeredChatDirectory = ({
  userId,
  portfolio,
  bsuid,
}: Readonly<{
  userId: string;
  portfolio: string;
  bsuid: string;
}>): UserStoreBindings["DIRECTORY"] => ({
  getByName: (name) => ({
    fetch: (input, init) => {
      const request = new Request(input, init);
      if (name !== directoryName || request.url !== whatsappBootstrapUrl) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return request.json().then((body: unknown) => {
        const caller = Schema.decodeUnknownSync(
          Schema.Struct({ portfolio: Schema.String, bsuid: Schema.String })
        )(body);
        return caller.portfolio === portfolio && caller.bsuid === bsuid
          ? Response.json({ userId })
          : new Response(null, { status: 404 });
      });
    },
  }),
});
