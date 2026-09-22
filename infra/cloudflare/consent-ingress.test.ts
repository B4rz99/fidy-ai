// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHmac } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { Effect, Schema } from "effect";
import { sweepExpiredConsent } from "./consent-ingress";
import { afterEach, expect, it, vi } from "vitest";
import coreWorker from "./core-worker";
import publicWorker from "./public-worker";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import { maxKapsoWebhookBytes } from "@fidy/server/consent-ingress";

const secret = "kapso-webhook-secret-for-consent-tests";
const portfolio = "portfolio-1";
const dayMs = 86_400_000;
const bsuid = "CO.13491208655302741918";
// @effect-diagnostics-next-line globalDate:off
const nowSeconds = Math.floor(Date.now() / 1000);
const migration = new URL("./migrations/0003_pending_consent.sql", import.meta.url);
const active = new Set<Miniflare>();
let databaseNumber = 0;

// @effect-diagnostics-next-line asyncFunction:off
const setup = async (): Promise<{
  readonly db: D1Database;
  readonly sweep: () => Promise<void>;
  readonly send: (body: string, signature?: string, eventName?: string) => Promise<Response>;
  readonly forbiddenEffects: Readonly<{
    queue: ReturnType<typeof vi.fn>;
    workflow: ReturnType<typeof vi.fn>;
    r2: ReturnType<typeof vi.fn>;
  }>;
}> => {
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
  await mf.ready;
  const db = await mf.getD1Database("DB");
  // Apply migrations and their statements in order; triggers must not be split at BEGIN/END.
  const applyMigration = (source: URL): Promise<unknown> =>
    readFile(source, "utf8").then((sql) =>
      sql
        .replace(/^--.*$/gmu, "")
        .trim()
        .split(/;\s*\n(?=CREATE |$)/u)
        .reduce<Promise<unknown>>(
          (previous, statement) => previous.then(() => db.prepare(statement).run()),
          Promise.resolve()
        )
    );
  await applyMigration(new URL("./migrations/0002_resource_admission.sql", import.meta.url));
  await applyMigration(migration);
  const send = (
    body: string,
    signature?: string,
    eventName = "whatsapp.message.received"
  ): Promise<Response> => {
    const bytes = new TextEncoder().encode(body);
    const proof = signature ?? createHmac("sha256", secret).update(bytes).digest("hex");
    return publicWorker.fetch(
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
        RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
        CORE: {
          fetch: (request) =>
            coreWorker.fetch(new Request(request), {
              AI: { run: () => Promise.reject(new Error("unused")) },
              CONTRACT_DIGEST: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
              DB: db,
              HOSTED_AI_MODEL: approvedWorkersAiModel,
              KAPSO_WEBHOOK_SECRET: secret,
              KAPSO_API_KEY: "fake-provider-key",
              WHATSAPP_BUSINESS_PORTFOLIO_ID: portfolio,
              RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
              // Canary bindings: a rejected webhook must not touch these authorities.
              ...canaryBindings,
            }),
        },
      }
    );
  };
  return { db, send, sweep: () => Effect.runPromise(sweepExpiredConsent(db)()), forbiddenEffects };
};

// @effect-diagnostics-next-line asyncFunction:off
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all([...active].map((mf) => mf.dispose()));
  active.clear();
});

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

// @effect-diagnostics-next-line asyncFunction:off
const startDisclosure = async (
  send: (body: string, signature?: string, eventName?: string) => Promise<Response>,
  firstText = "¿Qué es Fidy?"
): Promise<string> => {
  const provider = vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve(
      Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.disclosure-1" }] })
    )
  );
  vi.stubGlobal("fetch", provider);
  expect((await send(inbound("wamid.first", firstText))).status).toBe(200);
  expect(provider).toHaveBeenCalledTimes(1);
  const payload = Schema.decodeUnknownSync(ProviderSend)(
    JSON.parse(providerBody(provider.mock.calls[0]?.[1]))
  );
  expect(payload.text.body).toContain("Soy Fidy");
  return payload.biz_opaque_callback_data;
};

// @effect-diagnostics-next-line asyncFunction:off
const deliver = async (
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

// @effect-diagnostics-next-line asyncFunction:off
const advancePastDecisionProof = async (db: D1Database): Promise<string> => {
  const delivery = await db
    .prepare("SELECT decision_not_before_ms FROM pending_consent_delivery")
    .first();
  const afterProof = Number(delivery?.decision_not_before_ms) + 2_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(afterProof);
  return String(Math.ceil(afterProof / 1000));
};

// @effect-diagnostics-next-line asyncFunction:off
it("refuses forged and altered webhook bytes without any persistent or provider effect", async () => {
  const { db, send, forbiddenEffects } = await setup();
  const provider = vi.fn(() =>
    Promise.resolve(
      Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.unused" }] })
    )
  );
  vi.stubGlobal("fetch", provider);
  const valid = inbound("wamid.first", "Acepto");
  const signed = createHmac("sha256", secret).update(valid).digest("hex");
  expect((await send(inbound("wamid.first", "No acepto"), signed)).status).toBe(401);
  expect((await send(valid, "bad-proof")).status).toBe(401);
  expect((await db.prepare("SELECT * FROM pending_consent_exchanges").all()).results).toEqual([]);
  expect((await db.prepare("SELECT * FROM resource_admission_grants").all()).results).toEqual([]);
  expect(provider).not.toHaveBeenCalled();
  expect(forbiddenEffects.queue).not.toHaveBeenCalled();
  expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
  expect(forbiddenEffects.r2).not.toHaveBeenCalled();
});

// @effect-diagnostics-next-line asyncFunction:off
it("records only one origin-qualified pending acceptance despite duplicate and later conflicting replies", async () => {
  const { db, send } = await setup();
  const token = await startDisclosure(send);
  expect((await db.prepare("SELECT * FROM pending_consent_decisions").all()).results).toEqual([]);
  expect((await send(inbound("wamid.first", "¿Qué es Fidy?"))).status).toBe(200);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
  expect((await deliver(send, token, occurred)).status).toBe(200);
  expect((await deliver(send, token, occurred)).status).toBe(200);
  expect((await deliver(send, token, String(Number(occurred) + 1))).status).toBe(409);
  const decisionTime = await advancePastDecisionProof(db);
  expect((await send(inbound("wamid.decision-1", "Acepto", decisionTime))).status).toBe(200);
  expect((await send(inbound("wamid.decision-1", "Acepto", decisionTime))).status).toBe(200);
  expect((await send(inbound("wamid.decision-1", "No acepto", decisionTime))).status).toBe(409);
  expect(
    (await send(inbound("wamid.decision-2", "No acepto", String(nowSeconds - 10)))).status
  ).toBe(409);
  const { results } = await db
    .prepare(
      "SELECT decision, disclosure_json, disclosure_message_id, decision_message_id FROM pending_consent_decisions"
    )
    .all();
  expect(results).toHaveLength(1);
  expect(Schema.decodeUnknownSync(Schema.String)(results[0]?.disclosure_json)).toContain(
    "onboarding-2026-09-22"
  );
  expect(results).toMatchObject([
    {
      decision: "accepted",
      disclosure_message_id: "wamid.disclosure-1",
      decision_message_id: "wamid.decision-1",
    },
  ]);
  expect((await db.prepare("SELECT state FROM pending_consent_exchanges").first())?.state).toBe(
    "accepted"
  );
});

// @effect-diagnostics-next-line asyncFunction:off
it("rejects an oversized streamed webhook before admission or provider work", async () => {
  const { db, send, forbiddenEffects } = await setup();
  const provider = vi.fn(() => Promise.reject(new Error("provider must not be called")));
  vi.stubGlobal("fetch", provider);
  expect((await send("x".repeat(maxKapsoWebhookBytes + 1))).status).toBe(413);
  expect((await db.prepare("SELECT * FROM pending_consent_exchanges").all()).results).toEqual([]);
  expect((await db.prepare("SELECT * FROM resource_admission_events").all()).results).toEqual([]);
  expect(provider).not.toHaveBeenCalled();
  expect(forbiddenEffects.queue).not.toHaveBeenCalled();
  expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
  expect(forbiddenEffects.r2).not.toHaveBeenCalled();
});

// @effect-diagnostics-next-line asyncFunction:off
it("never treats a pre-disclosure acceptance replay as a Consent decision", async () => {
  const { db, send, forbiddenEffects } = await setup();
  const token = await startDisclosure(send, "Acepto");
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
  expect((await deliver(send, token, occurred)).status).toBe(200);
  expect((await send(inbound("wamid.first", "Acepto", occurred))).status).toBe(409);
  expect((await db.prepare("SELECT * FROM pending_consent_decisions").all()).results).toEqual([]);
  expect(forbiddenEffects.queue).not.toHaveBeenCalled();
  expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
  expect(forbiddenEffects.r2).not.toHaveBeenCalled();
  const decisionTime = await advancePastDecisionProof(db);
  expect((await send(inbound("wamid.new-decision", "Acepto", decisionTime))).status).toBe(200);
});

// @effect-diagnostics-next-line asyncFunction:off
it("rejects replay of a pre-delivery reply with a future-dated Kapso timestamp", async () => {
  const { db, send, forbiddenEffects } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  const deliveryTime = String(Math.ceil(Number(created?.created_at_ms) / 1000));
  const early = inbound("wamid.early-future", "Acepto", String(nowSeconds + 240));
  expect((await send(early)).status).toBe(409);
  expect((await deliver(send, token, deliveryTime)).status).toBe(200);
  const delivery = await db.prepare("SELECT received_at_ms FROM pending_consent_delivery").first();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Number(delivery?.received_at_ms) + 60_000);
  expect((await send(early)).status).toBe(409);
  expect((await db.prepare("SELECT * FROM pending_consent_decisions").all()).results).toEqual([]);
  const decisionTime = await advancePastDecisionProof(db);
  expect((await send(inbound("wamid.after-disclosure", "Acepto", decisionTime))).status).toBe(200);
  expect(forbiddenEffects.queue).not.toHaveBeenCalled();
  expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
  expect(forbiddenEffects.r2).not.toHaveBeenCalled();
});

// @effect-diagnostics-next-line asyncFunction:off
it("does not treat a malformed stored exchange as missing consent evidence", async () => {
  const { db, send } = await setup();
  await startDisclosure(send);
  await db
    .prepare("UPDATE pending_consent_exchanges SET correlation_token = ?")
    .bind("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
    .run();
  expect((await send(inbound("wamid.next", "Hola"))).status).toBe(503);
  expect((await db.prepare("SELECT * FROM pending_consent_exchanges").all()).results).toHaveLength(
    1
  );
});

// @effect-diagnostics-next-line asyncFunction:off
it("fails closed on an impossible stored decision lifecycle", async () => {
  const { db, send } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
  expect((await deliver(send, token, occurred)).status).toBe(200);
  const decisionTime = await advancePastDecisionProof(db);
  await db.prepare("UPDATE pending_consent_exchanges SET decision_not_before_ms = NULL").run();
  expect((await send(inbound("wamid.decision", "Acepto", decisionTime))).status).toBe(503);
  expect((await db.prepare("SELECT * FROM pending_consent_decisions").all()).results).toEqual([]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("replaces an expired attempt atomically and rejects its stale provider replay", async () => {
  const { db, send } = await setup();
  await startDisclosure(send);
  const expired = await db
    .prepare(`UPDATE pending_consent_exchanges
    SET created_at_ms = created_at_ms - ?, expires_at_ms = expires_at_ms - ?`)
    .bind(dayMs * 2, dayMs * 2)
    .run();
  expect(expired.meta.changes).toBe(1);
  const before = await db
    .prepare("SELECT initiating_message_id FROM pending_consent_exchanges")
    .first();
  expect((await send(inbound("wamid.first", "¿Qué es Fidy?"))).status).toBe(409);
  expect(
    await db.prepare("SELECT initiating_message_id FROM pending_consent_exchanges").first()
  ).toEqual(before);
  expect((await send(inbound("wamid.fresh", "Hola"))).status).toBe(200);
  expect(
    (await db.prepare("SELECT initiating_message_id FROM pending_consent_exchanges").all()).results
  ).toEqual([{ initiating_message_id: "wamid.fresh" }]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("sweeps expired evidence while idle and rejects its original signed webhook afterward", async () => {
  const { db, send, sweep, forbiddenEffects } = await setup();
  const original = inbound("wamid.first", "¿Qué es Fidy?");
  const provider = vi.fn(() =>
    Promise.resolve(
      Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.disclosure-1" }] })
    )
  );
  vi.stubGlobal("fetch", provider);
  expect((await send(original)).status).toBe(200);
  expect(provider).toHaveBeenCalledTimes(1);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(nowSeconds * 1000 + dayMs * 2);
  await sweep();
  expect((await db.prepare("SELECT * FROM pending_consent_exchanges").all()).results).toEqual([]);
  expect((await db.prepare("SELECT * FROM resource_admission_events").all()).results).toEqual([]);
  expect((await db.prepare("SELECT * FROM resource_admission_grants").all()).results).toEqual([]);
  expect((await send(original)).status).toBe(409);
  expect(provider).toHaveBeenCalledTimes(1);
  expect((await db.prepare("SELECT * FROM pending_consent_exchanges").all()).results).toEqual([]);
  expect(forbiddenEffects.queue).not.toHaveBeenCalled();
  expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
  expect(forbiddenEffects.r2).not.toHaveBeenCalled();
});

// @effect-diagnostics-next-line asyncFunction:off
it("cannot re-send disclosure with a future-dated signed event when its exchange expires", async () => {
  const { db, send, sweep, forbiddenEffects } = await setup();
  const original = inbound("wamid.first", "Hola", String(nowSeconds + 300));
  const provider = vi.fn(() =>
    Promise.resolve(
      Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.disclosure-1" }] })
    )
  );
  vi.stubGlobal("fetch", provider);
  expect((await send(original)).status).toBe(200);
  expect(provider).toHaveBeenCalledTimes(1);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Number(created?.created_at_ms) + dayMs + 1_000);
  await sweep();
  expect((await db.prepare("SELECT * FROM pending_consent_exchanges").all()).results).toEqual([]);
  expect((await send(original)).status).toBe(409);
  expect(provider).toHaveBeenCalledTimes(1);
  expect((await db.prepare("SELECT * FROM pending_consent_exchanges").all()).results).toEqual([]);
  expect((await db.prepare("SELECT * FROM resource_admission_events").all()).results).toEqual([]);
  expect(forbiddenEffects.queue).not.toHaveBeenCalled();
  expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
  expect(forbiddenEffects.r2).not.toHaveBeenCalled();
});

// @effect-diagnostics-next-line asyncFunction:off
it("settles simultaneous conflicting decisions at most once", async () => {
  const { db, send } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
  expect((await deliver(send, token, occurred)).status).toBe(200);
  const decisionTime = await advancePastDecisionProof(db);
  const replies = await Promise.all([
    send(inbound("wamid.concurrent-accept", "Acepto", decisionTime)),
    send(inbound("wamid.concurrent-decline", "No acepto", decisionTime)),
  ]);
  expect(replies.map((reply) => reply.status).sort((left, right) => left - right)).toEqual([
    200, 409,
  ]);
  expect(
    (await db.prepare("SELECT decision FROM pending_consent_decisions").all()).results
  ).toHaveLength(1);
});

// @effect-diagnostics-next-line asyncFunction:off
it("rejects forged, mismatched, and reordered delivery evidence without opening Consent", async () => {
  const { db, send } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
  const wrongPhone = JSON.stringify({
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
  expect((await send(wrongPhone, undefined, "whatsapp.message.delivered")).status).toBe(409);
  expect((await deliver(send, "11111111-1111-4111-8111-111111111111", occurred)).status).toBe(409);
  expect((await deliver(send, token, String(nowSeconds - 60))).status).toBe(409);
  const delivery = JSON.stringify({
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
  expect((await send(delivery, "forged", "whatsapp.message.delivered")).status).toBe(401);
  expect((await db.prepare("SELECT * FROM pending_consent_delivery").all()).results).toEqual([]);
  expect((await db.prepare("SELECT * FROM pending_consent_decisions").all()).results).toEqual([]);
  expect((await db.prepare("SELECT state FROM pending_consent_exchanges").first())?.state).toBe(
    "outbound_started"
  );
});

// @effect-diagnostics-next-line asyncFunction:off
it("requires the provider-returned message ID before any delivery callback may open decisions", async () => {
  const { db, send } = await setup();
  const pendingResponse = Promise.withResolvers<Response>();
  const provider = vi.fn((_url: string, _init: RequestInit) => pendingResponse.promise);
  vi.stubGlobal("fetch", provider);
  const sending = send(inbound("wamid.first", "Hola"));
  await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
  const payload = Schema.decodeUnknownSync(ProviderSend)(
    JSON.parse(providerBody(provider.mock.calls[0]?.[1]))
  );
  const token = payload.biz_opaque_callback_data;
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
  expect((await deliver(send, token, occurred)).status).toBe(409);
  expect((await db.prepare("SELECT * FROM pending_consent_delivery").all()).results).toEqual([]);
  pendingResponse.resolve(
    Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.disclosure-1" }] })
  );
  expect((await sending).status).toBe(200);
  const wrongId = JSON.stringify({
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
  expect((await send(wrongId, undefined, "whatsapp.message.delivered")).status).toBe(409);
  expect((await deliver(send, token, occurred)).status).toBe(200);
});

// @effect-diagnostics-next-line asyncFunction:off
it("records refusal without financial work and rejects a decision before verified disclosure", async () => {
  const { db, send } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
  expect((await send(inbound("wamid.early", "Acepto", occurred))).status).toBe(409);
  expect((await deliver(send, token, occurred)).status).toBe(200);
  expect((await send(inbound("wamid.early", "Acepto", occurred))).status).toBe(409);
  const otherPhone = inbound(
    "wamid.wrong-business-number",
    "Acepto",
    String(Number(occurred) + 1)
  ).replace('"phone_number_id":"123456789012345"', '"phone_number_id":"999999999999999"');
  expect((await send(otherPhone)).status).toBe(409);
  expect((await db.prepare("SELECT * FROM pending_consent_decisions").all()).results).toEqual([]);
  const decisionTime = await advancePastDecisionProof(db);
  expect((await send(inbound("wamid.refusal", "No acepto", decisionTime))).status).toBe(200);
  const { results } = await db.prepare("SELECT decision FROM pending_consent_decisions").all();
  expect(results).toEqual([{ decision: "declined" }]);
});
