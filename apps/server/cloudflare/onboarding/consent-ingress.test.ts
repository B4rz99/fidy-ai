import { Miniflare } from "miniflare";
import { type Cause, Clock, DateTime, Effect, Equal, Exit, Option, Schema } from "effect";
import { sweepExpiredConsent } from "./consent-ingress";
import {
  deliverOnboardingEmail,
  dispatchOnboardingEmail,
  receiveOnboardingEmail,
  runOnboardingEmailWorkflow,
} from "./onboarding-email";
import { afterEach, expect, it, vi } from "vitest";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import { maxKapsoWebhookBytes } from "@fidy/server/consent-ingress";

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
const statusCooldownElapsedMs = 61_000;
const bsuid = "CO.13491208655302741918";

const nowSeconds = Math.floor(Effect.runSync(Clock.currentTimeMillis) / 1000);
const migration = new URL("../migrations/0003_pending_consent.sql", import.meta.url);
const active = new Set<Miniflare>();
let databaseNumber = 0;

const seedSyntheticEnrollment = (
  db: D1Database,
  index: number
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const suffix = String(index).padStart(12, "0");
    const exchange = `00000000-0000-4000-8000-${suffix}`;
    const token = `00000001-0000-4000-8000-${suffix}`;
    const enrollment = `00000002-0000-4000-8000-${suffix}`;
    const caller = `CO.${String(index).padStart(20, "0")}`;
    yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO pending_consent_exchanges
      (id,portfolio_id,bsuid,phone_number_id,initiating_message_id,initiating_body_sha256,
       correlation_token,disclosure_json,disclosure_message_id,created_at_ms,expires_at_ms,state)
      SELECT ?,portfolio_id,?,phone_number_id,?,initiating_body_sha256,?,
        disclosure_json,disclosure_message_id,created_at_ms,expires_at_ms,'outbound_started'
      FROM pending_consent_exchanges WHERE bsuid = ?`)
        .bind(exchange, caller, `wamid.first-${index}`, token, bsuid)
        .run()
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO pending_consent_delivery
      (correlation_token,phone_number_id,message_id,occurred_at_ms,received_at_ms,decision_not_before_ms)
      SELECT ?,phone_number_id,message_id,occurred_at_ms,received_at_ms,decision_not_before_ms
      FROM pending_consent_delivery WHERE correlation_token = (
        SELECT correlation_token FROM pending_consent_exchanges WHERE bsuid = ?)`)
        .bind(token, bsuid)
        .run()
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO pending_consent_decisions
      (exchange_id,portfolio_id,bsuid,phone_number_id,decision,disclosure_json,disclosure_message_id,
       decision_message_id,delivery_key,body_sha256,occurred_at_ms,received_at_ms)
      SELECT ?,portfolio_id,?,phone_number_id,decision,disclosure_json,disclosure_message_id,
        ?,delivery_key,body_sha256,occurred_at_ms,received_at_ms
      FROM pending_consent_decisions WHERE bsuid = ?`)
        .bind(exchange, caller, `wamid.accept-${index}`, bsuid)
        .run()
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO pending_email_enrollments
      (id,exchange_id,email_address,submission_message_id,submission_body_sha256,created_at_ms,expires_at_ms,state)
      SELECT ?,?,email_address,?,submission_body_sha256,created_at_ms,expires_at_ms,state
      FROM pending_email_enrollments WHERE exchange_id = (
        SELECT id FROM pending_consent_exchanges WHERE bsuid = ?)`)
        .bind(enrollment, exchange, `wamid.email-${index}`, bsuid)
        .run()
    );
  });

const runSweep = (db: D1Database): Promise<void> => Effect.runPromise(sweepExpiredConsent(db)());

const setup = (): Promise<{
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
      const mf = new Miniflare({
        workers: [
          {
            config: {
              compatibilityDate: "2026-09-08",
              env: { DB: { id: `consent-test-${++databaseNumber}`, type: "d1" } },
              manifest: {
                mainModule: "index.mjs",
                modules: {
                  "index.mjs": {
                    contents: "export default {fetch() {return new Response('ok')}}",
                    type: "esm",
                  },
                },
              },
              name: `consent-test-${databaseNumber}`,
              type: "worker",
            },
          },
        ],
      });
      active.add(mf);
      yield* Effect.tryPromise(() => mf.ready);
      const db = yield* Effect.tryPromise(() => mf.getD1Database("DB"));
      // Apply migrations and their statements in order; triggers must not be split at BEGIN/END.
      const applyMigration = (source: URL): Promise<unknown> =>
        Bun.file(source)
          .text()
          .then((sql) =>
            sql
              .replace(/^--.*$/gmu, "")
              .trim()
              .split(/;\s*\n(?=CREATE |ALTER |$)/u)
              .reduce<Promise<unknown>>(
                (previous, statement) => previous.then(() => db.prepare(statement).run()),
                Promise.resolve()
              )
          );
      yield* Effect.tryPromise(() =>
        applyMigration(new URL("../migrations/0002_resource_admission.sql", import.meta.url))
      );
      yield* Effect.tryPromise(() => applyMigration(migration));
      yield* Effect.tryPromise(() =>
        applyMigration(new URL("../migrations/0004_onboarding_email.sql", import.meta.url))
      );
      const send = (
        body: string,
        signature?: string,
        eventName = "whatsapp.message.received"
      ): Promise<Response> => {
        const bytes = new TextEncoder().encode(body);
        return (
          signature === undefined ? signWebhook(secret, bytes) : Promise.resolve(signature)
        ).then((proof) =>
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
                      getByName: () => ({ fetch: () => Promise.reject(new Error("unused")) }),
                    },
                    KAPSO_WEBHOOK_SECRET: secret,
                    CLOUDFLARE_ACCESS_ISSUER: "",
                    CLOUDFLARE_ACCESS_AUDIENCE: "",
                    KAPSO_API_KEY: "fake-provider-key",
                    WHATSAPP_BUSINESS_PORTFOLIO_ID: portfolio,
                    RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
                    // Canary bindings: a rejected webhook must not touch these authorities.
                    ...canaryBindings,
                  }),
              },
            }
          )
        );
      };
      return {
        db,
        send,
        sweep: () => runSweep(db),
        forbiddenEffects,
      };
    })
  );

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      yield* Effect.tryPromise(() => Promise.all([...active].map((mf) => mf.dispose())));
      active.clear();
    })
  )
);

const inbound = (id: string, text: string, timestamp = String(nowSeconds)): string =>
  JSON.stringify({
    message: { id, timestamp, type: "text", from_user_id: bsuid, text: { body: text } },
    conversation: { business_scoped_user_id: bsuid },
    phone_number_id: "123456789012345",
  });

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
        db.prepare("SELECT decision_not_before_ms FROM pending_consent_delivery").first()
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
          db.prepare("SELECT * FROM pending_consent_decisions").all()
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
      const { results } = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT decision, disclosure_json, disclosure_message_id, decision_message_id FROM pending_consent_decisions"
          )
          .all()
      );
      expect(results).toHaveLength(1);
      expect(
        yield* Schema.decodeUnknownEffect(Schema.String)(results[0]?.disclosure_json)
      ).toContain("onboarding-2026-09-22");
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

it("does not enroll a replay of the mailbox message that initiated disclosure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send, "test@example.com"));
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT email_preaccept_latest_occurred_ms FROM pending_consent_exchanges")
            .first()
        ))?.email_preaccept_latest_occurred_ms
      ).toBe(nowSeconds * 1_000);
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))
        )).status
      ).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.accept", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.first", "test@example.com")))).status
      ).toBe(409);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_email_enrollments").all()
        )).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT * FROM onboarding_email_outbox").all()))
          .results
      ).toEqual([]);
    })
  ));

it("remembers a mailbox seen before disclosure delivery, without creating work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const preDeliveryEmail = inbound(
        "wamid.pre-delivery-email",
        "test@example.com",
        String(nowSeconds + 20)
      );
      expect((yield* Effect.tryPromise(() => send(preDeliveryEmail))).status).toBe(200);
      const guarded = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT email_preaccept_latest_occurred_ms FROM pending_consent_exchanges")
          .first()
      );
      expect(guarded?.email_preaccept_latest_occurred_ms).toBe((nowSeconds + 20) * 1_000);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT * FROM onboarding_email_outbox").all()))
          .results
      ).toEqual([]);
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))
        )).status
      ).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.accept", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      expect((yield* Effect.tryPromise(() => send(preDeliveryEmail))).status).toBe(409);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_email_enrollments").all()
        )).results
      ).toEqual([]);
    })
  ));

it("cannot replay a previously seen future-dated pre-Consent email into an enrollment", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))
        )).status
      ).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      const earlyEmail = inbound(
        "wamid.early-email",
        "test@example.com",
        String(Number(decisionTime) + 20)
      );
      expect((yield* Effect.tryPromise(() => send(earlyEmail))).status).toBe(200);
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.accept", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      expect((yield* Effect.tryPromise(() => send(earlyEmail))).status).toBe(409);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_email_enrollments").all()
        )).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT * FROM onboarding_email_outbox").all()))
          .results
      ).toEqual([]);
    })
  ));

it("commits one pending mailbox and outbox identity for an accepted Consent reply", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, forbiddenEffects } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
      expect((yield* Effect.tryPromise(() => deliver(send, token, occurred))).status).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.decision-1", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      const mailboxTime = String(Number(decisionTime) + 1);
      const wrongPhone = inbound("wamid.wrong-phone", "test@example.com", mailboxTime).replace(
        "123456789012345",
        "123456789012346"
      );
      expect((yield* Effect.tryPromise(() => send(wrongPhone))).status).toBe(409);
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.bad-email", "not an address", mailboxTime))
        )).status
      ).toBe(422);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT * FROM onboarding_email_outbox").all()))
          .results
      ).toEqual([]);
      const submission = inbound("wamid.email-1", "  Test@Example.com  ", mailboxTime);
      expect((yield* Effect.tryPromise(() => send(submission))).status).toBe(200);
      expect((yield* Effect.tryPromise(() => send(submission))).status).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.email-2", "else@example.com", mailboxTime))
        )).status
      ).toBe(409);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT email_address FROM pending_email_enrollments").all()
        )).results
      ).toMatchObject([{ email_address: "test@example.com" }]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT id, version FROM onboarding_email_outbox").all()
        )).results
      ).toMatchObject([{ version: 1 }]);
      expect(forbiddenEffects.queue).not.toHaveBeenCalled();
      expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
    })
  ));

it("reoffers the same bounded work after publication settlement is lost", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))
        )).status
      ).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.accept", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1)))
        )).status
      ).toBe(200);
      const offered = vi.fn((work: { readonly version: 1; readonly id: string }) =>
        Promise.resolve(work)
      );
      const dispatcher = {
        identity: Option.none<string>(),
        DB: db,
        ONBOARDING_EMAIL_QUEUE: { send: offered },
      };
      yield* dispatchOnboardingEmail(dispatcher);
      yield* dispatchOnboardingEmail(dispatcher);
      expect(offered).toHaveBeenCalledTimes(1);
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE onboarding_email_outbox SET last_attempt_at_ms = NULL").run()
      );
      yield* dispatchOnboardingEmail(dispatcher);
      expect(offered).toHaveBeenCalledTimes(2);
      expect(offered.mock.calls[0]).toEqual(offered.mock.calls[1]);
      expect(offered.mock.calls[0]?.[0]).toMatchObject({ version: 1 });
    })
  ));

it("continues to publish other identities when one Queue offer fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))
        )).status
      ).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.accept", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1)))
        )).status
      ).toBe(200);
      const secondExchange = "00000000-0000-4000-8000-000000000002";
      const secondToken = "00000000-0000-4000-8000-000000000003";
      const secondEnrollment = "00000000-0000-4000-8000-000000000004";
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO pending_consent_exchanges
    (id,portfolio_id,bsuid,phone_number_id,initiating_message_id,initiating_body_sha256,
     correlation_token,disclosure_json,disclosure_message_id,created_at_ms,expires_at_ms,state)
    SELECT ?,portfolio_id,?,phone_number_id,?,initiating_body_sha256,?,
      disclosure_json,disclosure_message_id,created_at_ms,expires_at_ms,'outbound_started'
    FROM pending_consent_exchanges LIMIT 1`)
          .bind(secondExchange, "CO.23491208655302741918", "wamid.second-first", secondToken)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO pending_consent_delivery
    (correlation_token,phone_number_id,message_id,occurred_at_ms,received_at_ms,decision_not_before_ms)
    SELECT ?,phone_number_id,message_id,occurred_at_ms,received_at_ms,decision_not_before_ms
    FROM pending_consent_delivery LIMIT 1`)
          .bind(secondToken)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO pending_consent_decisions
    (exchange_id,portfolio_id,bsuid,phone_number_id,decision,disclosure_json,disclosure_message_id,
     decision_message_id,delivery_key,body_sha256,occurred_at_ms,received_at_ms)
    SELECT ?,portfolio_id,?,phone_number_id,decision,disclosure_json,disclosure_message_id,
      ?,delivery_key,body_sha256,occurred_at_ms,received_at_ms
    FROM pending_consent_decisions LIMIT 1`)
          .bind(secondExchange, "CO.23491208655302741918", "wamid.second-accept")
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO pending_email_enrollments
    (id,exchange_id,email_address,submission_message_id,submission_body_sha256,created_at_ms,expires_at_ms,state)
    SELECT ?,?,email_address,?,submission_body_sha256,created_at_ms,expires_at_ms,state
    FROM pending_email_enrollments LIMIT 1`)
          .bind(secondEnrollment, secondExchange, "wamid.second-email")
          .run()
      );
      const offered = vi
        .fn()
        .mockRejectedValueOnce(new Error("queue unavailable"))
        .mockResolvedValue(undefined);
      expect(
        Equal.equals(
          yield* Effect.exit(
            dispatchOnboardingEmail({
              identity: Option.none(),
              DB: db,
              ONBOARDING_EMAIL_QUEUE: { send: offered },
            })
          ),
          Exit.fail(undefined)
        )
      ).toBe(true);
      expect(offered).toHaveBeenCalledTimes(2);
      yield* dispatchOnboardingEmail({
        identity: Option.none(),
        DB: db,
        ONBOARDING_EMAIL_QUEUE: { send: offered },
      });
      expect(offered).toHaveBeenCalledTimes(2);
      const states = yield* Effect.tryPromise(() =>
        db.prepare("SELECT published_at_ms, last_attempt_at_ms FROM onboarding_email_outbox").all()
      );
      expect(states.results.every((row) => row.last_attempt_at_ms !== null)).toBe(true);
      expect(states.results.filter((row) => row.published_at_ms === null)).toHaveLength(1);
      expect(states.results.filter((row) => row.published_at_ms !== null)).toHaveLength(1);
    })
  ));

it("offers the 33rd identity after an entire failing Queue batch cools down", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))
        )).status
      ).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.accept", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1)))
        )).status
      ).toBe(200);
      const syntheticEnrollments = 32;
      yield* Effect.forEach(
        Array.from({ length: syntheticEnrollments }, (_, index) => index + 1),
        (index) => seedSyntheticEnrollment(db, index),
        { concurrency: "unbounded" }
      );
      const offered = vi.fn().mockRejectedValue(new Error("Queue unavailable"));
      const dispatcher = {
        identity: Option.none<string>(),
        DB: db,
        ONBOARDING_EMAIL_QUEUE: { send: offered },
      };
      expect(
        Equal.equals(yield* Effect.exit(dispatchOnboardingEmail(dispatcher)), Exit.fail(undefined))
      ).toBe(true);
      expect(offered).toHaveBeenCalledTimes(32);
      const unattempted = yield* Effect.tryPromise(() =>
        db
          .prepare(`SELECT id FROM onboarding_email_outbox
    WHERE last_attempt_at_ms IS NULL`)
          .first()
      );
      expect(unattempted?.id).toBeDefined();
      offered.mockResolvedValueOnce(undefined);
      yield* dispatchOnboardingEmail(dispatcher);
      expect(offered).toHaveBeenCalledTimes(33);
      expect(offered.mock.calls[32]?.[0]).toEqual({ version: 1, id: unattempted?.id });
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(`SELECT COUNT(*) AS count FROM onboarding_email_outbox
    WHERE last_attempt_at_ms IS NULL`)
            .first()
        ))?.count
      ).toBe(0);
    })
  ));

it("rejects malformed Queue work before Workflow creation or provider delivery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Effect.tryPromise(() => setup());
      const created = vi.fn(() => Promise.resolve({}));
      const found = vi.fn(() => Promise.resolve({}));
      const ack = vi.fn();
      const batch: MessageBatch<unknown> = {
        queue: "onboarding-email",
        metadata: { metrics: { backlogCount: 1, backlogBytes: 20 } },
        ackAll: vi.fn(),
        retryAll: vi.fn(),
        messages: [
          {
            id: "malformed",
            body: { version: 1, id: "not-a-uuid", secret: "unexpected" },
            attempts: 1,

            timestamp: DateTime.toDate(DateTime.makeUnsafe(0)),
            retry: vi.fn(),
            ack,
          },
        ],
      };
      yield* receiveOnboardingEmail({
        DB: db,
        ONBOARDING_EMAIL_WORKFLOW: { create: created, get: found },
      })(batch);
      expect(ack).toHaveBeenCalledTimes(1);
      expect(created).not.toHaveBeenCalled();
      expect(found).not.toHaveBeenCalled();
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_email_enrollments").all()
        )).results
      ).toEqual([]);
    })
  ));

it("starts one deterministic Workflow identity despite Queue redelivery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))
        )).status
      ).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.accept", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1)))
        )).status
      ).toBe(200);
      const row = yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM pending_email_enrollments").first()
      );
      const id = (yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(row)).id;
      const createdWorkflow = vi
        .fn((work: { id: string; params: { version: 1; id: string } }) =>
          Promise.resolve({ id: work.id })
        )
        .mockImplementationOnce((work) => Promise.resolve({ id: work.id }))
        .mockRejectedValueOnce(new Error("already exists"));
      const found = vi.fn(() => Promise.resolve({ id }));
      const ack = vi.fn();
      const batch: MessageBatch<unknown> = {
        queue: "onboarding-email",
        metadata: { metrics: { backlogCount: 1, backlogBytes: 60 } },
        ackAll: vi.fn(),
        retryAll: vi.fn(),
        messages: [
          {
            id: "work-1",
            body: { version: 1, id },
            attempts: 1,

            timestamp: DateTime.toDate(DateTime.makeUnsafe(0)),
            retry: vi.fn(),
            ack,
          },
        ],
      };
      const worker = receiveOnboardingEmail({
        DB: db,
        ONBOARDING_EMAIL_WORKFLOW: { create: createdWorkflow, get: found },
      });
      yield* worker(batch);
      yield* worker(batch);
      expect(createdWorkflow).toHaveBeenCalledTimes(2);
      expect(createdWorkflow.mock.calls[0]).toEqual(createdWorkflow.mock.calls[1]);
      expect(createdWorkflow.mock.calls[0]?.[0]).toEqual({ id, params: { version: 1, id } });
      expect(found).toHaveBeenCalledWith(id);
      expect(ack).toHaveBeenCalledTimes(2);
      createdWorkflow.mockRejectedValueOnce(new Error("uncertain start"));
      found.mockRejectedValueOnce(new Error("cannot confirm instance"));
      expect(Equal.equals(yield* Effect.exit(worker(batch)), Exit.fail(undefined))).toBe(true);
      expect(ack).toHaveBeenCalledTimes(2);
      yield* worker(batch);
      expect(createdWorkflow).toHaveBeenCalledTimes(4);
      expect(ack).toHaveBeenCalledTimes(3);
    })
  ));

it("runs the versioned Workflow Activity under replay without repeating provider delivery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))
        )).status
      ).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.accept", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1)))
        )).status
      ).toBe(200);
      const row = yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM pending_email_enrollments").first()
      );
      const id = (yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(row)).id;
      const provider = vi.fn(() => Promise.resolve(Response.json({ id: "resend-message-id" })));
      vi.stubGlobal("fetch", provider);
      const steps: Array<string> = [];
      const activity = (
        name: string,
        _options: unknown,
        run: () => Promise<void>
      ): Promise<void> => {
        steps.push(name);
        return run();
      };
      const environment = { DB: db, RESEND_API_KEY: "test-provider-key" };
      yield* Effect.tryPromise(() =>
        runOnboardingEmailWorkflow({
          environment,
          payload: { version: 1, id },
          activity,
        })
      );
      yield* Effect.tryPromise(() =>
        runOnboardingEmailWorkflow({
          environment,
          payload: { version: 1, id },
          activity,
        })
      );
      yield* Effect.tryPromise(() =>
        runOnboardingEmailWorkflow({
          environment,
          payload: { version: 2, id },
          activity,
        })
      );
      expect(steps).toEqual(["send-onboarding-verification-v1", "send-onboarding-verification-v1"]);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT state FROM pending_email_enrollments").first()
        ))?.state
      ).toBe("awaiting_proof");
    })
  ));

it("keeps only a digest after one Resend acceptance and cannot send again on Activity replay", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))
        )).status
      ).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.accept", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1)))
        )).status
      ).toBe(200);
      const row = yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM pending_email_enrollments").first()
      );
      const id = (yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(row)).id;
      const provider = vi.fn(() => Promise.resolve(Response.json({ id: "email_provider_1" })));
      vi.stubGlobal("fetch", provider);
      yield* Effect.tryPromise(() =>
        deliverOnboardingEmail({ DB: db, RESEND_API_KEY: "test-provider-key" })(id)
      );
      yield* Effect.tryPromise(() =>
        deliverOnboardingEmail({ DB: db, RESEND_API_KEY: "test-provider-key" })(id)
      );
      expect(provider).toHaveBeenCalledTimes(1);
      const proof = yield* Effect.tryPromise(() =>
        db
          .prepare(`SELECT state, public_code, proof_digest, proof_expires_at_ms
    FROM pending_email_enrollments WHERE id = ?`)
          .bind(id)
          .first()
      );
      expect(proof?.state).toBe("awaiting_proof");
      expect(proof?.public_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
      const digest = proof?.proof_digest;
      expect(
        yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })))
        )(digest)
      ).toHaveLength(32);
      expect(
        encodeJson(
          yield* Effect.tryPromise(() => db.prepare("SELECT * FROM onboarding_email_outbox").all())
        )
      ).not.toContain("email_provider_1");
    })
  ));

it("treats malformed Resend acceptance as ambiguous rather than sending another proof", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))
        )).status
      ).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.accept", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1)))
        )).status
      ).toBe(200);
      const row = yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM pending_email_enrollments").first()
      );
      const id = (yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(row)).id;
      const provider = vi.fn(() => Promise.resolve(Response.json({ bogus: "not a message id" })));
      vi.stubGlobal("fetch", provider);
      yield* Effect.tryPromise(() =>
        deliverOnboardingEmail({ DB: db, RESEND_API_KEY: "test-provider-key" })(id)
      );
      yield* Effect.tryPromise(() =>
        deliverOnboardingEmail({ DB: db, RESEND_API_KEY: "test-provider-key" })(id)
      );
      expect(provider).toHaveBeenCalledTimes(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT state FROM pending_email_enrollments").first()
        ))?.state
      ).toBe("ambiguous");
    })
  ));

it("lets only the accepted WhatsApp caller request a bounded, proof-free delivery status", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))
        )).status
      ).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.accept", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1)))
        )).status
      ).toBe(200);
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE pending_email_enrollments SET state = 'rejected'").run()
      );
      const provider = vi.fn((_url: string, _init: RequestInit) =>
        Promise.resolve(
          Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.status" }] })
        )
      );
      vi.stubGlobal("fetch", provider);
      const status = inbound("wamid.status-request", "Estado", String(Number(decisionTime) + 2));
      expect((yield* Effect.tryPromise(() => send(status, "invalid-signature"))).status).toBe(401);
      expect(
        (yield* Effect.tryPromise(() => send(status.replaceAll(bsuid, "CO.23491208655302741918"))))
          .status
      ).toBe(409);
      expect(
        (yield* Effect.tryPromise(() => send(status.replace("123456789012345", "123456789012346"))))
          .status
      ).toBe(409);
      expect(provider).not.toHaveBeenCalled();
      expect((yield* Effect.tryPromise(() => send(status))).status).toBe(200);
      expect((yield* Effect.tryPromise(() => send(status))).status).toBe(200);
      expect(provider).toHaveBeenCalledTimes(1);
      const payload = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          text: Schema.Struct({ body: Schema.String }),
        })
      )(decodeJson(providerBody(provider.mock.calls[0]?.[1])));
      expect(payload.text.body).toContain("rechazó");
      expect(payload.text.body).not.toContain("test@example.com");
      expect(payload.text.body).not.toMatch(/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/u);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT email_status_attempts FROM pending_consent_exchanges").first()
        ))?.email_status_attempts
      ).toBe(1);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE pending_consent_exchanges SET email_status_last_ms = email_status_last_ms - ?"
          )
          .bind(statusCooldownElapsedMs)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE pending_email_enrollments SET state = 'ambiguous'").run()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.status-uncertain", "Estado", String(Number(decisionTime) + 3)))
        )).status
      ).toBe(200);
      expect(provider).toHaveBeenCalledTimes(2);
      const uncertain = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          text: Schema.Struct({ body: Schema.String }),
        })
      )(decodeJson(providerBody(provider.mock.calls[1]?.[1])));
      expect(uncertain.text.body).toContain("No podemos confirmar");
      expect(uncertain.text.body).not.toContain("test@example.com");
    })
  ));

it("marks an interrupted provider call ambiguous without repeating the send", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const token = yield* Effect.tryPromise(() => startDisclosure(send));
      const created = yield* Effect.tryPromise(() =>
        db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))
        )).status
      ).toBe(200);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.accept", "Acepto", decisionTime))))
          .status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1)))
        )).status
      ).toBe(200);
      const row = yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM pending_email_enrollments").first()
      );
      const id = (yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(row)).id;
      const provider = vi.fn(() => Promise.reject(new Error("connection lost after request")));
      vi.stubGlobal("fetch", provider);
      yield* Effect.tryPromise(() =>
        deliverOnboardingEmail({ DB: db, RESEND_API_KEY: "test-provider-key" })(id)
      );
      yield* Effect.tryPromise(() =>
        deliverOnboardingEmail({ DB: db, RESEND_API_KEY: "test-provider-key" })(id)
      );
      expect(provider).toHaveBeenCalledTimes(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT state FROM pending_email_enrollments").first()
        ))?.state
      ).toBe("ambiguous");
    })
  ));

it("rejects an oversized streamed webhook before admission or provider work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, forbiddenEffects } = yield* Effect.tryPromise(() => setup());
      const provider = vi.fn(() => Promise.reject(new Error("provider must not be called")));
      vi.stubGlobal("fetch", provider);
      expect(
        (yield* Effect.tryPromise(() => send("x".repeat(maxKapsoWebhookBytes + 1)))).status
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
          db.prepare("SELECT * FROM pending_consent_decisions").all()
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
        db.prepare("SELECT received_at_ms FROM pending_consent_delivery").first()
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Number(delivery?.received_at_ms) + 60_000);
      expect((yield* Effect.tryPromise(() => send(early))).status).toBe(409);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_consent_decisions").all()
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
          db.prepare("SELECT * FROM pending_consent_decisions").all()
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
          db.prepare("SELECT decision FROM pending_consent_decisions").all()
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
        (yield* Effect.tryPromise(() => db.prepare("SELECT * FROM pending_consent_delivery").all()))
          .results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM pending_consent_decisions").all()
        )).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT state FROM pending_consent_exchanges").first()
        ))?.state
      ).toBe("outbound_started");
    })
  ));

it("requires the provider-returned message ID before any delivery callback may open decisions", () =>
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
      expect((yield* Effect.tryPromise(() => deliver(send, token, occurred))).status).toBe(409);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT * FROM pending_consent_delivery").all()))
          .results
      ).toEqual([]);
      pendingResponse.resolve(
        Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.disclosure-1" }] })
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
  ));

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
          db.prepare("SELECT * FROM pending_consent_decisions").all()
        )).results
      ).toEqual([]);
      const decisionTime = yield* Effect.tryPromise(() => advancePastDecisionProof(db));
      expect(
        (yield* Effect.tryPromise(() => send(inbound("wamid.refusal", "No acepto", decisionTime))))
          .status
      ).toBe(200);
      const { results } = yield* Effect.tryPromise(() =>
        db.prepare("SELECT decision FROM pending_consent_decisions").all()
      );
      expect(results).toEqual([{ decision: "declined" }]);
    })
  ));
