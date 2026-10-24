import {
  disposeLegacyConsent,
  receiveLegacyConsent,
} from "../provider-authentication/legacy-disclosure.test-fixture";
import { UserTransactionCoordinator } from "../transactions/runtime";
import { DisclosureSnapshot, maxWhatsAppWebhookBytes } from "../../src/shell/consent/contract";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import { Clock, Effect, Exit, Option, Schema } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { recoverPendingDisclosures, sweepExpiredConsent } from "../consent/ingress/runtime";
import {
  consentHistoryTestSchema,
  installCurrentTestObjects,
  installRetentionTestSchema,
  isolatedTestDatabases,
} from "../d1-test-fixture";
import { WhatsAppStatusAdmission, WhatsAppTurnAdmission } from "../whatsapp/contract";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";

const signWebhook = (secret: string, body: string | Uint8Array): Promise<string> =>
  crypto.subtle
    .importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ])
    .then((key) =>
      crypto.subtle.sign(
        "HMAC",
        key,
        typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body)
      )
    )
    .then((bytes) =>
      Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
    );

const encodeJson = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);
const decodeJson = (value: string): unknown =>
  Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const secret = "kapso-webhook-secret-for-consent-tests";
const portfolio = "portfolio-1";
const dayMs = 86_400_000;
const bsuid = "CO.13491208655302741918";

const nowSeconds = Math.floor(Effect.runSync(Clock.currentTimeMillis) / 1000);
const databases = isolatedTestDatabases();
afterAll(() => Promise.all([databases.dispose(), disposeLegacyConsent()]));

const runSweep = (db: D1Database): Promise<void> => Effect.runPromise(sweepExpiredConsent(db)());

const setup = (
  coordinator: Option.Option<
    (userId: string, request: Request) => Promise<Response>
  > = Option.none(),
  preparedDatabase: Option.Option<D1Database> = Option.none()
): Promise<{
  readonly db: D1Database;
  readonly sweep: () => Promise<void>;
  readonly send: (body: string, signature?: string, eventName?: string) => Promise<Response>;
  readonly forbiddenEffects: Readonly<{
    queue: ReturnType<typeof vi.fn>;
    workflow: ReturnType<typeof vi.fn>;
    r2: ReturnType<typeof vi.fn>;
  }>;
}> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const forbiddenEffects = { queue: vi.fn(), workflow: vi.fn(), r2: vi.fn() };
      const canaryBindings = {
        QUEUE: { send: forbiddenEffects.queue },
        WORKFLOW: { create: forbiddenEffects.workflow },
        R2: { put: forbiddenEffects.r2 },
      };
      const db = Option.isSome(preparedDatabase)
        ? preparedDatabase.value
        : yield* Effect.tryPromise(() => databases.acquire());
      if (Option.isNone(preparedDatabase)) {
        yield* Effect.tryPromise(() =>
          installCurrentTestObjects({
            db,
            tables: [
              "resource_admission_grants",
              "resource_admission_events",
              "web_sessions",
              "whatsapp_event_records",
              "pending_consent_exchanges",
              "whatsapp_service_windows",
            ],
          })
        );
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "CREATE TABLE whatsapp_provider_handoffs (id TEXT PRIMARY KEY,exchange_id TEXT,created_at_ms INTEGER,expires_at_ms INTEGER,handoff_send_started_ms INTEGER,pairing_id TEXT,review_code TEXT,review_started_ms INTEGER,review_message_id TEXT,decision TEXT,consumed_at_ms INTEGER)"
            )
            .run()
        );
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,service_market TEXT,locale TEXT,time_zone TEXT,created_at_ms INTEGER,whatsapp_portfolio_id TEXT,whatsapp_bsuid TEXT,whatsapp_verified_at_ms INTEGER)"
            )
            .run()
        );
        yield* Effect.tryPromise(() => db.prepare(consentHistoryTestSchema).run());
        yield* Effect.tryPromise(() =>
          db.prepare("CREATE TABLE consent_user_revocations (user_id TEXT)").run()
        );
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "CREATE TABLE whatsapp_deliveries (kind TEXT,user_id TEXT, correlation_token TEXT, business_phone_number_id TEXT, proposed_at_ms INTEGER, state TEXT,send_started_at_ms INTEGER,hosted_correlation_token TEXT GENERATED ALWAYS AS(CASE WHEN kind='hosted' THEN correlation_token END) VIRTUAL UNIQUE)"
            )
            .run()
        );
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare(
              "CREATE TABLE insight_whatsapp_claims (user_id TEXT, correlation_token TEXT, business_phone_number_id TEXT, send_started_at_ms INTEGER)"
            ),
            db.prepare(
              "CREATE TABLE weekly_governor_questions (user_id TEXT, correlation_token TEXT, business_phone_number_id TEXT, send_started_at_ms INTEGER)"
            ),
            db.prepare(
              "CREATE TABLE proactivity_whatsapp_claims (user_id TEXT, correlation_token TEXT, business_phone_number_id TEXT, send_started_at_ms INTEGER)"
            ),
          ])
        );
      }
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TABLE IF NOT EXISTS whatsapp_signup_invitations(id TEXT PRIMARY KEY,source_portfolio_id TEXT,source_bsuid TEXT,source_phone_number_id TEXT,source_message_id TEXT,source_phone TEXT,created_at_ms INTEGER,expires_at_ms INTEGER)"
          )
          .run()
      );
      const send = (
        body: string,
        signature?: string,
        eventName = "whatsapp.message.received"
      ): Promise<Response> => {
        const bytes = new TextEncoder().encode(body);
        return (
          signature === undefined ? signWebhook(secret, bytes) : Promise.resolve(signature)
        ).then((proof) => {
          const native = (): Promise<Response> =>
            publicWorker.fetch(
              new Request("https://api.fidyapp.com/providers/kapso/callback", {
                method: "POST",
                headers: {
                  "x-webhook-signature": proof,
                  "x-webhook-event": eventName,
                  "x-idempotency-key": "delivery-1",
                },
                body: bytes,
              }),
              {
                BROWSER_ORIGIN: "https://app.fidyapp.com",
                LOCAL_CANONICAL_READ_BEARER: "local",
                PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
                RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
                CORE: {
                  fetch: (request) =>
                    coreWorker.fetch(new Request(request), {
                      AI: { run: () => Promise.reject(new Error("unused")) },
                      CONTRACT_DIGEST:
                        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
                      DB: db,
                      HOSTED_AI_MODEL: approvedWorkersAiModel,
                      BROWSER_ORIGIN: "https://app.fidyapp.com",
                      WOMPI_ENVIRONMENT: "",
                      WOMPI_PUBLIC_KEY: "",
                      WOMPI_PRIVATE_KEY: "",
                      WOMPI_INTEGRITY_SECRET: "",
                      USER_TRANSACTION_COORDINATOR: {
                        getByName: (name: string) => ({
                          fetch: (request: Request) =>
                            Option.isSome(coordinator)
                              ? coordinator.value(name, request)
                              : Promise.reject(new Error("unused")),
                        }),
                      },
                      KAPSO_WEBHOOK_SECRET: secret,
                      CLOUDFLARE_ACCESS_ISSUER: "",
                      CLOUDFLARE_ACCESS_AUDIENCE: "",
                      KAPSO_API_KEY: "fake-provider-key",
                      WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",

                      WHATSAPP_BUSINESS_PORTFOLIO_ID: portfolio,
                      RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
                      ...canaryBindings,
                    }),
                },
              }
            );
          const parsed = Schema.decodeOption(
            Schema.fromJsonString(
              Schema.Struct({
                message: Schema.optionalKey(
                  Schema.Struct({ type: Schema.optionalKey(Schema.String) })
                ),
              })
            )
          )(body);
          return eventName === "whatsapp.message.received" &&
            Option.isSome(parsed) &&
            parsed.value.message?.type === "text"
            ? receiveLegacyConsent({
                db,
                rawBody: bytes,
                signature: proof,
                secret,
                portfolio,
                sandboxPhoneNumberId: "",
                deliveryKey: "delivery-1",
                native,
              })
            : native();
        });
      };
      return {
        db,
        send,
        sweep: () => runSweep(db),
        forbiddenEffects,
      };
    })
  );

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const inbound = (id: string, text: string, timestamp = String(nowSeconds)): string =>
  JSON.stringify({
    message: { id, timestamp, type: "text", from_user_id: bsuid, text: { body: text } },
    conversation: { business_scoped_user_id: bsuid },
    phone_number_id: "123456789012345",
  });

const voiceInbound = (id: string, transcript?: unknown, caller = bsuid): string =>
  encodeJson({
    message: {
      id,
      timestamp: String(nowSeconds),
      type: "audio",
      from_user_id: caller,
      audio: { id: "media-1" },
      kapso: transcript === undefined ? {} : { transcript },
    },
    conversation: { business_scoped_user_id: caller },
    phone_number_id: "123456789012345",
  });

const seedVoiceUser = (db: D1Database, userId: string): Promise<unknown> =>
  db
    .prepare(
      "WITH incoming(user_id,portfolio_id,bsuid) AS (VALUES (?, ?, ?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.portfolio_id,incoming.bsuid,0 FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET whatsapp_portfolio_id=excluded.whatsapp_portfolio_id,whatsapp_bsuid=excluded.whatsapp_bsuid,whatsapp_verified_at_ms=excluded.whatsapp_verified_at_ms"
    )
    .bind(userId, portfolio, bsuid)
    .run()
    .then(() =>
      db
        .prepare("INSERT INTO consent_history (record_type,user_id) VALUES ('processing_grant',?)")
        .bind(userId)
        .run()
    );

it("refuses image work while extraction is unavailable without treating its caption as a credential or hosted Turn", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const coordinator = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
      const provider = vi.fn(() =>
        Promise.reject(new Error("image retrieval or delivery must not run"))
      );
      const { db, send, forbiddenEffects } = yield* Effect.tryPromise(() =>
        setup(Option.some(coordinator))
      );
      yield* Effect.tryPromise(() => seedVoiceUser(db, "10000000-0000-4000-8000-000000000071"));
      vi.stubGlobal("fetch", provider);
      for (const caller of [bsuid, "CO.99999999999999999999"]) {
        const payload = encodeJson({
          message: {
            id: `wamid.image-${caller}`,
            timestamp: String(nowSeconds),
            type: "image",
            from_user_id: caller,
            image: {
              id: "image-media-1",
              caption: "Aprueba el código de inicio de sesión BCDF-GHJK",
            },
            kapso: { media_url: "https://untrusted.example/image" },
          },
          conversation: { business_scoped_user_id: caller },
          phone_number_id: "123456789012345",
        });
        expect((yield* Effect.tryPromise(() => send(payload, "invalid"))).status).toBe(401);
        const response = yield* Effect.tryPromise(() => send(payload));
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      expect(coordinator).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(forbiddenEffects.queue).not.toHaveBeenCalled();
      expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
      expect(forbiddenEffects.r2).not.toHaveBeenCalled();
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT id FROM pending_consent_exchanges").all()
        )).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT exchange_id FROM (SELECT rowid,id AS exchange_id,portfolio_id,bsuid,phone_number_id,decision_value AS decision,disclosure_json,disclosure_message_id,decision_message_id,decision_delivery_key AS delivery_key,decision_body_sha256 AS body_sha256,decision_occurred_at_ms AS occurred_at_ms,decision_received_at_ms AS received_at_ms FROM pending_consent_exchanges WHERE decision_value IS NOT NULL) AS pending_consent_decisions"
            )
            .all()
        )).results
      ).toEqual([]);
    })
  ));

it.each([
  { messageId: "wamid.verified", text: "Texto exacto", voice: false },
  { messageId: "wamid.voice", text: "Transcripción", voice: true },
  {
    messageId: "wamid.voice-control",
    text: "Aprueba el código de inicio de sesión BCDF-GHJK",
    voice: true,
  },
])(
  "retains one authenticated verified input despite callback replay: $messageId",
  ({ messageId, text, voice }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => databases.acquire());
        yield* Effect.tryPromise(() => installRetentionTestSchema(db));
        const userId = "10000000-0000-4000-8000-000000000071";
        const timestamp = yield* Clock.currentTimeMillis;
        const snapshot = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot))
        )(currentDisclosureFor());
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
              )
              .bind(userId, timestamp),
            db
              .prepare(
                "WITH incoming(user_id,portfolio_id,bsuid,verified_at_ms) AS (VALUES (?, ?, ?, ?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.portfolio_id,incoming.bsuid,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET whatsapp_portfolio_id=excluded.whatsapp_portfolio_id,whatsapp_bsuid=excluded.whatsapp_bsuid,whatsapp_verified_at_ms=excluded.whatsapp_verified_at_ms"
              )
              .bind(userId, portfolio, bsuid, timestamp),
            db
              .prepare(
                "INSERT INTO consent_history (record_type,id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, occurred_at_ms) VALUES ('processing_grant',?, ?, ?, 'disclosed', 'accepted', ?, ?)"
              )
              .bind("10000000-0000-4000-8000-000000000073", userId, snapshot, timestamp, timestamp),
          ])
        );
        const coordinator = new UserTransactionCoordinator(
          {
            id: { name: userId },
            storage: {
              getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> => Promise.resolve(null),
              deleteAlarm: (): Promise<void> => Promise.resolve(),
              setAlarm: (): Promise<void> => Promise.resolve(),
            },
          },
          {
            DB: db,
            KAPSO_API_KEY: "fake-provider-key",
            HOSTED_AI_MODEL: approvedWorkersAiModel,
            AI: {
              run: (): Promise<Response> =>
                Promise.resolve(
                  Response.json({
                    choices: [
                      {
                        message: { role: "assistant", content: "Respuesta segura" },
                        finish_reason: "stop",
                      },
                    ],
                    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
                  })
                ),
            },
          }
        );
        const { send } = yield* Effect.tryPromise(() =>
          setup(
            Option.some((name, request) => {
              expect(name).toBe(userId);
              return coordinator.fetch(request);
            }),
            Option.some(db)
          )
        );
        vi.stubGlobal("fetch", () =>
          Promise.resolve(
            Response.json({
              messaging_product: "whatsapp",
              messages: [{ id: "wamid.output" }],
            })
          )
        );
        const payload = voice ? voiceInbound(messageId, { text }) : inbound(messageId, text);
        expect((yield* Effect.tryPromise(() => send(payload, "invalid"))).status).toBe(401);
        expect(
          (yield* Effect.tryPromise(() => db.prepare("SELECT id FROM hosted_turns").all())).results
        ).toEqual([]);
        expect((yield* Effect.tryPromise(() => send(payload))).status).toBe(202);
        expect((yield* Effect.tryPromise(() => send(payload))).status).toBe(200);
        expect(
          (yield* Effect.tryPromise(() =>
            db
              .prepare(`SELECT t.user_id, t.status, e.kind, e.text
        FROM hosted_turns t JOIN transcript_entries e ON e.turn_id = t.id
        ORDER BY e.sequence`)
              .all()
          )).results
        ).toEqual([{ user_id: userId, status: "pending", kind: "user", text }]);
        expect(
          (yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT d.user_id, i.message_id, d.text, d.provider_message_id, d.state FROM (SELECT * FROM whatsapp_deliveries WHERE kind='hosted') d JOIN (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) i ON i.turn_id = d.turn_id"
              )
              .all()
          )).results
        ).toEqual([
          {
            user_id: userId,
            message_id: messageId,
            text: "Respuesta segura",
            provider_message_id: "wamid.output",
            state: "accepted",
          },
        ]);
        const sweptReplay = inbound(
          "wamid.swept",
          "Texto exacto",
          String(nowSeconds - 31 * 86_400)
        );
        expect((yield* Effect.tryPromise(() => send(sweptReplay))).status).toBe(409);
        expect(
          (yield* Effect.tryPromise(() => db.prepare("SELECT id FROM hosted_turns").all())).results
        ).toHaveLength(1);
      })
    )
);

it("preserves a contextual reply identity across the Core-to-coordinator wire codec", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const coordinator = (_userId: string, request: Request): Promise<Response> =>
        request.json().then((body: unknown) => {
          calls.push(body);
          return new Response(null, { status: 202 });
        });
      const { db, send } = yield* Effect.tryPromise(() => setup(Option.some(coordinator)));
      yield* Effect.tryPromise(() => seedVoiceUser(db, "10000000-0000-4000-8000-000000000071"));
      const reply = encodeJson({
        message: {
          id: "wamid.contextual-reply",
          timestamp: String(nowSeconds),
          type: "text",
          from_user_id: bsuid,
          text: { body: "Sigue" },
          context: { id: "wamid.proactive" },
        },
        conversation: { business_scoped_user_id: bsuid },
        phone_number_id: "123456789012345",
      });
      expect((yield* Effect.tryPromise(() => send(reply))).status).toBe(202);
      expect(calls).toHaveLength(1);
      const admission = yield* Schema.decodeUnknownEffect(WhatsAppTurnAdmission)(calls[0]);
      expect(admission.replyToMessageId).toEqual(Option.some("wamid.proactive"));
      expect(admission.text).toBe("Sigue");
    })
  ));

it("answers unusable authenticated voice once without admitting a Turn or inferring", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const calls = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
      const { db, send, sweep } = yield* Effect.tryPromise(() => setup(Option.some(calls)));
      const userId = "10000000-0000-4000-8000-000000000071";
      yield* Effect.tryPromise(() => seedVoiceUser(db, userId));
      const provider = vi.fn((_url: string, _init: RequestInit) =>
        Promise.resolve(
          Response.json({
            messaging_product: "whatsapp",
            messages: [{ id: "wamid.voice-reply" }],
          })
        )
      );
      vi.stubGlobal("fetch", provider);
      const missing = voiceInbound("wamid.voice-missing");
      expect((yield* Effect.tryPromise(() => send(missing, "invalid"))).status).toBe(401);
      expect(provider).not.toHaveBeenCalled();
      expect((yield* Effect.tryPromise(() => send(missing))).status).toBe(200);
      expect((yield* Effect.tryPromise(() => send(missing))).status).toBe(200);
      expect(provider).toHaveBeenCalledTimes(1);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO consent_history(record_type,user_id) VALUES ('processing_withdrawal',?)"
          )
          .bind(userId)
          .run()
      );
      expect((yield* Effect.tryPromise(() => send(voiceInbound("wamid.revoked")))).status).toBe(
        429
      );
      expect(provider).toHaveBeenCalledTimes(1);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "DELETE FROM consent_history WHERE record_type='processing_withdrawal' AND user_id = ?"
          )
          .bind(userId)
          .run()
      );
      const sent = decodeJson(providerBody(provider.mock.calls[0]?.[1]));
      expect(sent).toMatchObject({
        type: "text",
        recipient: bsuid,
        text: {
          body: "No pude procesar la nota de voz. Envíala de nuevo o escríbeme.",
        },
      });
      for (const [index, transcript] of [
        { text: "  " },
        { text: 12 },
        { text: "x".repeat(16_001) },
        { unsupported: true },
      ].entries()) {
        expect(
          (yield* Effect.tryPromise(() => send(voiceInbound(`wamid.bad-${index}`, transcript))))
            .status
        ).toBe(200);
      }
      expect(provider).toHaveBeenCalledTimes(5);
      expect(
        (yield* Effect.tryPromise(() =>
          send(voiceInbound("wamid.malformed-kapso").replace('"kapso":{}', '"kapso":null'))
        )).status
      ).toBe(429);
      expect(provider).toHaveBeenCalledTimes(5);
      expect(
        (yield* Effect.tryPromise(() =>
          send(voiceInbound("wamid.unknown", undefined, "CO.99999999999999999999"))
        )).status
      ).toBe(422);
      expect(provider).toHaveBeenCalledTimes(5);
      expect(calls).not.toHaveBeenCalled();
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO whatsapp_event_records
          (kind,portfolio_id,message_id,user_id,claimed_at_ms,outcome) VALUES ('voice-refusal',?,?,?,?,'started')`)
          .bind(portfolio, "wamid.expired", userId, nowSeconds * 1_000 - 8 * dayMs)
          .run()
      );
      yield* Effect.tryPromise(() => sweep());
      const expired = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT message_id FROM (SELECT rowid,portfolio_id,message_id,user_id,claimed_at_ms,outcome FROM whatsapp_event_records WHERE kind='voice-refusal') WHERE message_id = 'wamid.expired'"
          )
          .first()
      );
      expect(expired).toBeNull();
    })
  ));

it("reports a failed voice reply truthfully without retrying its uncertain provider attempt", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const calls = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
      const { db, send } = yield* Effect.tryPromise(() => setup(Option.some(calls)));
      const userId = "10000000-0000-4000-8000-000000000071";
      yield* Effect.tryPromise(() => seedVoiceUser(db, userId));
      const provider = vi.fn(() => Promise.reject(new Error("provider may have accepted")));
      vi.stubGlobal("fetch", provider);
      const payload = voiceInbound("wamid.ambiguous-voice");
      expect((yield* Effect.tryPromise(() => send(payload))).status).toBe(503);
      expect((yield* Effect.tryPromise(() => send(payload))).status).toBe(503);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(calls).not.toHaveBeenCalled();
    })
  ));

it("routes only signed, correlated Kapso delivery evidence to the same User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const calls: Array<Readonly<{ userId: string; request: unknown }>> = [];
      const coordinator = (userId: string, request: Request): Promise<Response> =>
        request.json().then((body: unknown) => {
          calls.push({ userId, request: body });
          return new Response(null, { status: 200 });
        });
      const { db, send } = yield* Effect.tryPromise(() => setup(Option.some(coordinator)));
      const userId = "10000000-0000-4000-8000-000000000071";
      const token = "10000000-0000-4000-8000-000000000122";
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            `INSERT INTO whatsapp_deliveries AS hosted_whatsapp_delivery(kind,user_id, correlation_token, business_phone_number_id) VALUES ('hosted',?, ?, ?)`
          )
          .bind(userId, token, "123456789012345")
          .run()
      );
      const proof = encodeJson({
        message: {
          id: "wamid.disclosure-1",
          kapso: {
            statuses: [
              {
                id: "wamid.disclosure-1",
                status: "delivered",
                timestamp: String(nowSeconds),
                biz_opaque_callback_data: token,
              },
            ],
          },
        },
        phone_number_id: "123456789012345",
      });
      expect(
        (yield* Effect.tryPromise(() => send(proof, "invalid", "whatsapp.message.delivered")))
          .status
      ).toBe(401);
      expect(calls).toHaveLength(0);
      expect(
        (yield* Effect.tryPromise(() => send(proof, undefined, "whatsapp.message.delivered")))
          .status
      ).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.userId).toBe(userId);
      const forwarded = yield* Schema.decodeUnknownEffect(WhatsAppStatusAdmission)(
        calls[0]?.request
      );
      expect(forwarded).toMatchObject({
        userId,
        correlationToken: token,
        providerMessageId: "wamid.disclosure-1",
        outcome: "delivered",
      });
    })
  ));

const ProviderSend = Schema.Struct({
  biz_opaque_callback_data: Schema.String,
  text: Schema.Struct({ body: Schema.String }),
});

const providerBody = (options?: RequestInit): string => {
  if (typeof options?.body === "string") return options.body;
  if (options?.body instanceof Uint8Array) return new TextDecoder().decode(options.body);
  throw new Error("Expected provider JSON bytes");
};

const startDisclosure = (
  send: (body: string, signature?: string, eventName?: string) => Promise<Response>,
  firstText = "¿Qué es Fidy?"
): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = vi.fn((_url: string, _init: RequestInit) =>
        Promise.resolve(
          Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.disclosure-1" }] })
        )
      );
      vi.stubGlobal("fetch", provider);
      expect((yield* Effect.tryPromise(() => send(inbound("wamid.first", firstText)))).status).toBe(
        200
      );
      expect(provider).toHaveBeenCalledTimes(1);
      const payload = yield* Schema.decodeUnknownEffect(ProviderSend)(
        decodeJson(providerBody(provider.mock.calls[0]?.[1]))
      );
      expect(payload.text.body).toContain("Soy Fidy");
      return payload.biz_opaque_callback_data;
    })
  );

const deliver = (
  send: (body: string, signature?: string, eventName?: string) => Promise<Response>,
  token: string,
  timestamp: string
): Promise<Response> =>
  send(
    JSON.stringify({
      message: {
        id: "wamid.disclosure-1",
        kapso: {
          statuses: [
            {
              id: "wamid.disclosure-1",
              status: "delivered",
              timestamp,
              biz_opaque_callback_data: token,
            },
          ],
        },
      },
      phone_number_id: "123456789012345",
    }),
    undefined,
    "whatsapp.message.delivered"
  );

const advancePastDecisionProof = (db: D1Database): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const delivery = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT decision_not_before_ms FROM (SELECT rowid,correlation_token,delivery_phone_number_id AS phone_number_id,delivery_message_id AS message_id,delivery_occurred_at_ms AS occurred_at_ms,delivery_received_at_ms AS received_at_ms,delivery_not_before_ms AS decision_not_before_ms FROM pending_consent_exchanges WHERE delivery_message_id IS NOT NULL) AS pending_consent_delivery"
          )
          .first()
      );
      const afterProof = Number(delivery?.decision_not_before_ms) + 2_000;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(afterProof);
      return String(Math.ceil(afterProof / 1000));
    })
  );

it("refuses forged and altered webhook bytes without any persistent or provider effect", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, forbiddenEffects } = yield* Effect.tryPromise(() => setup());
      const provider = vi.fn(() =>
        Promise.resolve(
          Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.unused" }] })
        )
      );
      vi.stubGlobal("fetch", provider);
      const valid = inbound("wamid.first", "Acepto");
      const signed = yield* Effect.tryPromise(() => signWebhook(secret, valid));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.first", "No acepto"), signed))).status
      ).toBe(401);
      expect((yield* Effect.tryPromise(() => send(valid, "bad-proof"))).status).toBe(401);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_consent_exchanges").all()
        )).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM resource_admission_grants").all()
        )).results
      ).toEqual([]);
      expect(provider).not.toHaveBeenCalled();
      expect(forbiddenEffects.queue).not.toHaveBeenCalled();
      expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
      expect(forbiddenEffects.r2).not.toHaveBeenCalled();
    })
  ));

it("records only one origin-qualified pending acceptance despite duplicate and later conflicting replies", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT * FROM (SELECT id AS exchange_id,portfolio_id,bsuid,phone_number_id,decision_value AS decision,disclosure_json,disclosure_message_id,decision_message_id,decision_delivery_key AS delivery_key,decision_body_sha256 AS body_sha256,decision_occurred_at_ms AS occurred_at_ms,decision_received_at_ms AS received_at_ms FROM pending_consent_exchanges WHERE decision_value IS NOT NULL) AS pending_consent_decisions"
            )
            .all()
        )).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.first", "¿Qué es Fidy?")))).status
      ).toBe(200);
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
      expect((yield* Effect.tryPromise(() => deliver(send, token, occurred))).status).toBe(200);
      expect((yield* Effect.tryPromise(() => deliver(send, token, occurred))).status).toBe(200);
      expect(
        (yield* Effect.tryPromise(() => deliver(send, token, String(Number(occurred) + 1)))).status
      ).toBe(409);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.decision-1", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.decision-1", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.decision-1", "No acepto", decisionTime))
        )).status
      ).toBe(409);
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.decision-2", "No acepto", String(nowSeconds - 10)))
        )).status
      ).toBe(409);
      for (const mutation of [
        "portfolio_id='another-portfolio'",
        "bsuid='another-recipient'",
        "phone_number_id='987654321'",
        "disclosure_json='{}'",
        "disclosure_message_id='another-disclosure'",
      ]) {
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              Effect.tryPromise(() =>
                db.prepare(`UPDATE pending_consent_exchanges SET ${mutation}`).run()
              )
            )
          )
        ).toBe(true);
      }
      const { results } = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT decision, disclosure_json, disclosure_message_id, decision_message_id FROM (SELECT rowid,id AS exchange_id,portfolio_id,bsuid,phone_number_id,decision_value AS decision,disclosure_json,disclosure_message_id,decision_message_id,decision_delivery_key AS delivery_key,decision_body_sha256 AS body_sha256,decision_occurred_at_ms AS occurred_at_ms,decision_received_at_ms AS received_at_ms FROM pending_consent_exchanges WHERE decision_value IS NOT NULL) AS pending_consent_decisions"
          )
          .all()
      );
      expect(results).toHaveLength(1);
      expect(
        yield* Schema.decodeUnknownEffect(Schema.String)(results[0]?.disclosure_json)
      ).toContain("onboarding-2026-10-08-providers");
      expect(results).toMatchObject([
        {
          decision: "accepted",
          disclosure_message_id: "wamid.disclosure-1",
          decision_message_id: "wamid.decision-1",
        },
      ]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT state FROM pending_consent_exchanges").first()
        ))?.state
      ).toBe("accepted");
    })
  ));

it("rejects an oversized streamed webhook before admission or provider work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, forbiddenEffects } = yield* Effect.tryPromise(() => setup());
      const provider = vi.fn(() => Promise.reject(new Error("provider must not be called")));
      vi.stubGlobal("fetch", provider);
      expect(
        (yield* Effect.tryPromise(() => send("x".repeat(maxWhatsAppWebhookBytes + 1)))).status
      ).toBe(413);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_consent_exchanges").all()
        )).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM resource_admission_events").all()
        )).results
      ).toEqual([]);
      expect(provider).not.toHaveBeenCalled();
      expect(forbiddenEffects.queue).not.toHaveBeenCalled();
      expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
      expect(forbiddenEffects.r2).not.toHaveBeenCalled();
    })
  ));

it("never treats a pre-disclosure acceptance replay as a Consent decision", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, forbiddenEffects } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send, "Acepto"));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
      expect((yield* Effect.tryPromise(() => deliver(send, token, occurred))).status).toBe(200);
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.first", "Acepto", occurred)))).status
      ).toBe(409);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT * FROM (SELECT id AS exchange_id,portfolio_id,bsuid,phone_number_id,decision_value AS decision,disclosure_json,disclosure_message_id,decision_message_id,decision_delivery_key AS delivery_key,decision_body_sha256 AS body_sha256,decision_occurred_at_ms AS occurred_at_ms,decision_received_at_ms AS received_at_ms FROM pending_consent_exchanges WHERE decision_value IS NOT NULL) AS pending_consent_decisions"
            )
            .all()
        )).results
      ).toEqual([]);
      expect(forbiddenEffects.queue).not.toHaveBeenCalled();
      expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
      expect(forbiddenEffects.r2).not.toHaveBeenCalled();
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.new-decision", "Acepto", decisionTime))
        )).status
      ).toBe(200);
    })
  ));

it("rejects replay of a pre-delivery reply with a future-dated Kapso timestamp", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, forbiddenEffects } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      const deliveryTime = String(Math.ceil(Number(created?.created_at_ms) / 1000));
      const early = inbound("wamid.early-future", "Acepto", String(nowSeconds + 240));
      expect((yield* Effect.tryPromise(() => send(early))).status).toBe(409);
      expect((yield* Effect.tryPromise(() => deliver(send, token, deliveryTime))).status).toBe(200);
      const delivery = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT received_at_ms FROM (SELECT rowid,correlation_token,delivery_phone_number_id AS phone_number_id,delivery_message_id AS message_id,delivery_occurred_at_ms AS occurred_at_ms,delivery_received_at_ms AS received_at_ms,delivery_not_before_ms AS decision_not_before_ms FROM pending_consent_exchanges WHERE delivery_message_id IS NOT NULL) AS pending_consent_delivery"
          )
          .first()
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Number(delivery?.received_at_ms) + 60_000);
      expect((yield* Effect.tryPromise(() => send(early))).status).toBe(409);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT * FROM (SELECT id AS exchange_id,portfolio_id,bsuid,phone_number_id,decision_value AS decision,disclosure_json,disclosure_message_id,decision_message_id,decision_delivery_key AS delivery_key,decision_body_sha256 AS body_sha256,decision_occurred_at_ms AS occurred_at_ms,decision_received_at_ms AS received_at_ms FROM pending_consent_exchanges WHERE decision_value IS NOT NULL) AS pending_consent_decisions"
            )
            .all()
        )).results
      ).toEqual([]);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.after-disclosure", "Acepto", decisionTime))
        )).status
      ).toBe(200);
      expect(forbiddenEffects.queue).not.toHaveBeenCalled();
      expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
      expect(forbiddenEffects.r2).not.toHaveBeenCalled();
    })
  ));

it("reports unavailable when the disclosure admission store fails without contacting Kapso", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() => db.prepare("DROP TABLE resource_admission_grants").run());
      const response = yield* Effect.tryPromise(() =>
        send(inbound("wamid.admission-down", "Hola"))
      );
      expect(response.status).toBe(503);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_consent_exchanges").all()
        )).results
      ).toEqual([]);
    })
  ));

it("does not treat a malformed stored exchange as missing consent evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() => startDisclosure(send));
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE pending_consent_exchanges SET correlation_token = ?")
          .bind("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
          .run()
      );
      expect((yield* Effect.tryPromise(() => send(inbound("wamid.next", "Hola")))).status).toBe(
        503
      );
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_consent_exchanges").all()
        )).results
      ).toHaveLength(1);
    })
  ));

it("fails closed on an impossible stored decision lifecycle", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
      expect((yield* Effect.tryPromise(() => deliver(send, token, occurred))).status).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE pending_consent_exchanges SET decision_not_before_ms = NULL").run()
      );
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.decision", "Acepto", decisionTime))))
          .status
      ).toBe(503);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT * FROM (SELECT id AS exchange_id,portfolio_id,bsuid,phone_number_id,decision_value AS decision,disclosure_json,disclosure_message_id,decision_message_id,decision_delivery_key AS delivery_key,decision_body_sha256 AS body_sha256,decision_occurred_at_ms AS occurred_at_ms,decision_received_at_ms AS received_at_ms FROM pending_consent_exchanges WHERE decision_value IS NOT NULL) AS pending_consent_decisions"
            )
            .all()
        )).results
      ).toEqual([]);
    })
  ));

it("replaces an expired attempt atomically and rejects its stale provider replay", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() => startDisclosure(send));
      const expired = yield* Effect.tryPromise(() =>
        db
          .prepare(`UPDATE pending_consent_exchanges
    SET created_at_ms = created_at_ms - ?, expires_at_ms = expires_at_ms - ?`)
          .bind(dayMs * 2, dayMs * 2)
          .run()
      );
      expect(expired.meta.changes).toBe(1);
      const before = yield* Effect.tryPromise(() =>
        db.prepare("SELECT initiating_message_id FROM pending_consent_exchanges").first()
      );
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.first", "¿Qué es Fidy?")))).status
      ).toBe(409);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT initiating_message_id FROM pending_consent_exchanges").first()
        )
      ).toEqual(before);
      expect((yield* Effect.tryPromise(() => send(inbound("wamid.fresh", "Hola")))).status).toBe(
        200
      );
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT initiating_message_id FROM pending_consent_exchanges").all()
        )).results
      ).toEqual([{ initiating_message_id: "wamid.fresh" }]);
    })
  ));

it("sweeps expired evidence while idle and rejects its original signed webhook afterward", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, sweep, forbiddenEffects } = yield* Effect.tryPromise(() => setup());
      const original = inbound("wamid.first", "¿Qué es Fidy?");
      const provider = vi.fn(() =>
        Promise.resolve(
          Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.disclosure-1" }] })
        )
      );
      vi.stubGlobal("fetch", provider);
      expect((yield* Effect.tryPromise(() => send(original))).status).toBe(200);
      expect(provider).toHaveBeenCalledTimes(1);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(nowSeconds * 1000 + dayMs * 2);
      yield* Effect.tryPromise(() => sweep());
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_consent_exchanges").all()
        )).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM resource_admission_events").all()
        )).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM resource_admission_grants").all()
        )).results
      ).toEqual([]);
      expect((yield* Effect.tryPromise(() => send(original))).status).toBe(409);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_consent_exchanges").all()
        )).results
      ).toEqual([]);
      expect(forbiddenEffects.queue).not.toHaveBeenCalled();
      expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
      expect(forbiddenEffects.r2).not.toHaveBeenCalled();
    })
  ));

it("cannot re-send disclosure with a future-dated signed event when its exchange expires", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, sweep, forbiddenEffects } = yield* Effect.tryPromise(() => setup());
      const original = inbound("wamid.first", "Hola", String(nowSeconds + 300));
      const provider = vi.fn(() =>
        Promise.resolve(
          Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.disclosure-1" }] })
        )
      );
      vi.stubGlobal("fetch", provider);
      expect((yield* Effect.tryPromise(() => send(original))).status).toBe(200);
      expect(provider).toHaveBeenCalledTimes(1);
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Number(created?.created_at_ms) + dayMs + 1_000);
      yield* Effect.tryPromise(() => sweep());
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_consent_exchanges").all()
        )).results
      ).toEqual([]);
      expect((yield* Effect.tryPromise(() => send(original))).status).toBe(409);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_consent_exchanges").all()
        )).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM resource_admission_events").all()
        )).results
      ).toEqual([]);
      expect(forbiddenEffects.queue).not.toHaveBeenCalled();
      expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
      expect(forbiddenEffects.r2).not.toHaveBeenCalled();
    })
  ));

it("settles simultaneous conflicting decisions at most once", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
      expect((yield* Effect.tryPromise(() => deliver(send, token, occurred))).status).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      const replies = yield* Effect.tryPromise(() =>
        Promise.all([
          send(inbound("wamid.concurrent-accept", "Acepto", decisionTime)),
          send(inbound("wamid.concurrent-decline", "No acepto", decisionTime)),
        ])
      );
      expect(replies.map((reply) => reply.status).sort((left, right) => left - right)).toEqual([
        200, 409,
      ]);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT decision FROM (SELECT rowid,id AS exchange_id,portfolio_id,bsuid,phone_number_id,decision_value AS decision,disclosure_json,disclosure_message_id,decision_message_id,decision_delivery_key AS delivery_key,decision_body_sha256 AS body_sha256,decision_occurred_at_ms AS occurred_at_ms,decision_received_at_ms AS received_at_ms FROM pending_consent_exchanges WHERE decision_value IS NOT NULL) AS pending_consent_decisions"
            )
            .all()
        )).results
      ).toHaveLength(1);
    })
  ));

it("rejects forged, mismatched, and reordered delivery evidence without opening Consent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
      const wrongPhone = encodeJson({
        message: {
          id: "wamid.disclosure-1",
          kapso: {
            statuses: [
              {
                id: "wamid.disclosure-1",
                status: "delivered",
                timestamp: occurred,
                biz_opaque_callback_data: token,
              },
            ],
          },
        },
        phone_number_id: "999999999999999",
      });
      expect(
        (yield* Effect.tryPromise(() => send(wrongPhone, undefined, "whatsapp.message.delivered")))
          .status
      ).toBe(409);
      expect(
        (yield* Effect.tryPromise(() =>
          deliver(send, "11111111-1111-4111-8111-111111111111", occurred)
        )).status
      ).toBe(409);
      expect(
        (yield* Effect.tryPromise(() => deliver(send, token, String(nowSeconds - 60)))).status
      ).toBe(409);
      const delivery = encodeJson({
        message: {
          id: "wamid.disclosure-1",
          kapso: {
            statuses: [
              {
                id: "wamid.disclosure-1",
                status: "delivered",
                timestamp: occurred,
                biz_opaque_callback_data: token,
              },
            ],
          },
        },
        phone_number_id: "123456789012345",
      });
      expect(
        (yield* Effect.tryPromise(() => send(delivery, "forged", "whatsapp.message.delivered")))
          .status
      ).toBe(401);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT * FROM (SELECT correlation_token,delivery_phone_number_id AS phone_number_id,delivery_message_id AS message_id,delivery_occurred_at_ms AS occurred_at_ms,delivery_received_at_ms AS received_at_ms,delivery_not_before_ms AS decision_not_before_ms FROM pending_consent_exchanges WHERE delivery_message_id IS NOT NULL) AS pending_consent_delivery"
            )
            .all()
        )).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT * FROM (SELECT id AS exchange_id,portfolio_id,bsuid,phone_number_id,decision_value AS decision,disclosure_json,disclosure_message_id,decision_message_id,decision_delivery_key AS delivery_key,decision_body_sha256 AS body_sha256,decision_occurred_at_ms AS occurred_at_ms,decision_received_at_ms AS received_at_ms FROM pending_consent_exchanges WHERE decision_value IS NOT NULL) AS pending_consent_decisions"
            )
            .all()
        )).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT state FROM pending_consent_exchanges").first()
        ))?.state
      ).toBe("outbound_started");
    })
  ));

it("recovers a committed pre-send disclosure once without resending a started attempt", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Effect.tryPromise(() => setup());
      const token = "14390000-0000-4000-8000-000000000001";
      const current = yield* Clock.currentTimeMillis;
      const provider = vi.fn((_url: string, _init: RequestInit) =>
        Promise.resolve(
          Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.recovered" }] })
        )
      );
      vi.stubGlobal("fetch", provider);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            `INSERT INTO pending_consent_exchanges(id,portfolio_id,bsuid,phone_number_id,
              initiating_message_id,initiating_body_sha256,correlation_token,disclosure_json,
              created_at_ms,expires_at_ms,state) VALUES(?,?,?,'123456789012345','first',?,?,?,?,?,'awaiting_delivery')`
          )
          .bind(
            token,
            portfolio,
            bsuid,
            "a".repeat(64),
            token,
            encodeJson(currentDisclosureFor()),
            current,
            current + dayMs
          )
          .run()
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            recoverPendingDisclosures({ db, sandboxPhoneNumberId: Option.none(), apiKey: "" })
          )
        )
      ).toBe(true);
      yield* recoverPendingDisclosures({
        db,
        sandboxPhoneNumberId: Option.none(),
        apiKey: "fake-provider-key",
      });
      yield* recoverPendingDisclosures({
        db,
        sandboxPhoneNumberId: Option.none(),
        apiKey: "fake-provider-key",
      });
      yield* recoverPendingDisclosures({ db, sandboxPhoneNumberId: Option.none(), apiKey: "" });
      expect(provider).toHaveBeenCalledTimes(1);
      const payload = yield* Schema.decodeUnknownEffect(ProviderSend)(
        decodeJson(providerBody(provider.mock.calls[0]?.[1]))
      );
      expect(payload.biz_opaque_callback_data).toBe(token);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT state FROM pending_consent_exchanges").first()
        ))?.state
      ).toBe("outbound_started");
    })
  ));

it.each([200, 403])(
  "preserves authenticated delivery evidence before the send response is retained: %s",
  (providerStatus) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, send } = yield* Effect.tryPromise(() => setup());
        const pendingResponse = Promise.withResolvers<Response>();
        const provider = vi.fn((_url: string, _init: RequestInit) => pendingResponse.promise);
        vi.stubGlobal("fetch", provider);
        const sending = send(inbound("wamid.first", "Hola"));
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1)));
        const payload = yield* Schema.decodeUnknownEffect(ProviderSend)(
          decodeJson(providerBody(provider.mock.calls[0]?.[1]))
        );
        const token = payload.biz_opaque_callback_data;
        const created = yield* Effect.tryPromise(() =>
          db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
        );
        const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
        expect((yield* Effect.tryPromise(() => deliver(send, token, occurred))).status).toBe(200);
        expect(
          (yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT * FROM (SELECT correlation_token,delivery_phone_number_id AS phone_number_id,delivery_message_id AS message_id,delivery_occurred_at_ms AS occurred_at_ms,delivery_received_at_ms AS received_at_ms,delivery_not_before_ms AS decision_not_before_ms FROM pending_consent_exchanges WHERE delivery_message_id IS NOT NULL) AS pending_consent_delivery"
              )
              .all()
          )).results
        ).toHaveLength(1);
        pendingResponse.resolve(
          providerStatus === 403
            ? Response.json(
                { error: "BSUID recipients are not supported in sandbox mode" },
                { status: 403 }
              )
            : Response.json({
                messaging_product: "whatsapp",
                messages: [{ id: "wamid.disclosure-1" }],
              })
        );
        expect((yield* Effect.tryPromise(() => sending)).status).toBe(200);
        const wrongId = encodeJson({
          message: {
            id: "wamid.other",
            kapso: {
              statuses: [
                {
                  id: "wamid.other",
                  status: "delivered",
                  timestamp: occurred,
                  biz_opaque_callback_data: token,
                },
              ],
            },
          },
          phone_number_id: "123456789012345",
        });
        expect(
          (yield* Effect.tryPromise(() => send(wrongId, undefined, "whatsapp.message.delivered")))
            .status
        ).toBe(409);
        expect((yield* Effect.tryPromise(() => deliver(send, token, occurred))).status).toBe(200);
      })
    )
);

it("records refusal without financial work and rejects a decision before verified disclosure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.early", "Acepto", occurred)))).status
      ).toBe(409);
      expect((yield* Effect.tryPromise(() => deliver(send, token, occurred))).status).toBe(200);
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.early", "Acepto", occurred)))).status
      ).toBe(409);
      const otherPhone = inbound(
        "wamid.wrong-business-number",
        "Acepto",
        String(Number(occurred) + 1)
      ).replace('"phone_number_id":"123456789012345"', '"phone_number_id":"999999999999999"');
      expect((yield* Effect.tryPromise(() => send(otherPhone))).status).toBe(409);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT * FROM (SELECT id AS exchange_id,portfolio_id,bsuid,phone_number_id,decision_value AS decision,disclosure_json,disclosure_message_id,decision_message_id,decision_delivery_key AS delivery_key,decision_body_sha256 AS body_sha256,decision_occurred_at_ms AS occurred_at_ms,decision_received_at_ms AS received_at_ms FROM pending_consent_exchanges WHERE decision_value IS NOT NULL) AS pending_consent_decisions"
            )
            .all()
        )).results
      ).toEqual([]);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.refusal", "No acepto", decisionTime))))
          .status
      ).toBe(200);
      const { results } = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT decision FROM (SELECT rowid,id AS exchange_id,portfolio_id,bsuid,phone_number_id,decision_value AS decision,disclosure_json,disclosure_message_id,decision_message_id,decision_delivery_key AS delivery_key,decision_body_sha256 AS body_sha256,decision_occurred_at_ms AS occurred_at_ms,decision_received_at_ms AS received_at_ms FROM pending_consent_exchanges WHERE decision_value IS NOT NULL) AS pending_consent_decisions"
          )
          .all()
      );
      expect(results).toEqual([{ decision: "declined" }]);
    })
  ));
