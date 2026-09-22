// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHmac } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { sweepExpiredConsent } from "./consent-ingress";
import {
  OnboardingEmailWorkflowV1,
  deliverOnboardingEmail,
  dispatchOnboardingEmail,
  receiveOnboardingEmail,
} from "./onboarding-email";
import { afterEach, expect, it, vi } from "vitest";
import coreWorker from "./core-worker";
import publicWorker from "./public-worker";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import { maxKapsoWebhookBytes } from "@fidy/server/consent-ingress";

const secret = "kapso-webhook-secret-for-consent-tests";
const portfolio = "portfolio-1";
const dayMs = 86_400_000;
const statusCooldownElapsedMs = 61_000;
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
        .split(/;\s*\n(?=CREATE |ALTER |$)/u)
        .reduce<Promise<unknown>>(
          (previous, statement) => previous.then(() => db.prepare(statement).run()),
          Promise.resolve()
        )
    );
  await applyMigration(new URL("./migrations/0002_resource_admission.sql", import.meta.url));
  await applyMigration(migration);
  await applyMigration(new URL("./migrations/0004_onboarding_email.sql", import.meta.url));
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
it("cannot replay a previously seen future-dated pre-Consent email into an enrollment", async () => {
  const { db, send } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  expect(
    (await deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))).status
  ).toBe(200);
  const decisionTime = await advancePastDecisionProof(db);
  const earlyEmail = inbound(
    "wamid.early-email",
    "test@example.com",
    String(Number(decisionTime) + 20)
  );
  expect((await send(earlyEmail)).status).toBe(200);
  expect((await send(inbound("wamid.accept", "Acepto", decisionTime))).status).toBe(200);
  expect((await send(earlyEmail)).status).toBe(409);
  expect((await db.prepare("SELECT * FROM pending_email_enrollments").all()).results).toEqual([]);
  expect((await db.prepare("SELECT * FROM onboarding_email_outbox").all()).results).toEqual([]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("commits one pending mailbox and outbox identity for an accepted Consent reply", async () => {
  const { db, send, forbiddenEffects } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  const occurred = String(Math.ceil(Number(created?.created_at_ms) / 1000));
  expect((await deliver(send, token, occurred)).status).toBe(200);
  const decisionTime = await advancePastDecisionProof(db);
  expect((await send(inbound("wamid.decision-1", "Acepto", decisionTime))).status).toBe(200);
  const mailboxTime = String(Number(decisionTime) + 1);
  const wrongPhone = inbound("wamid.wrong-phone", "test@example.com", mailboxTime).replace(
    "123456789012345",
    "123456789012346"
  );
  expect((await send(wrongPhone)).status).toBe(409);
  expect((await send(inbound("wamid.bad-email", "not an address", mailboxTime))).status).toBe(422);
  expect((await db.prepare("SELECT * FROM onboarding_email_outbox").all()).results).toEqual([]);
  const submission = inbound("wamid.email-1", "  Test@Example.com  ", mailboxTime);
  expect((await send(submission)).status).toBe(200);
  expect((await send(submission)).status).toBe(200);
  expect((await send(inbound("wamid.email-2", "else@example.com", mailboxTime))).status).toBe(409);
  expect(
    (await db.prepare("SELECT email_address FROM pending_email_enrollments").all()).results
  ).toMatchObject([{ email_address: "test@example.com" }]);
  expect(
    (await db.prepare("SELECT id, version FROM onboarding_email_outbox").all()).results
  ).toMatchObject([{ version: 1 }]);
  expect(forbiddenEffects.queue).not.toHaveBeenCalled();
  expect(forbiddenEffects.workflow).not.toHaveBeenCalled();
});

// @effect-diagnostics-next-line asyncFunction:off
it("reoffers the same bounded work after publication settlement is lost", async () => {
  const { db, send } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  expect(
    (await deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))).status
  ).toBe(200);
  const decisionTime = await advancePastDecisionProof(db);
  expect((await send(inbound("wamid.accept", "Acepto", decisionTime))).status).toBe(200);
  expect(
    (await send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1))))
      .status
  ).toBe(200);
  const offered = vi.fn((work: { readonly version: 1; readonly id: string }) =>
    Promise.resolve(work)
  );
  const dispatcher = { DB: db, ONBOARDING_EMAIL_QUEUE: { send: offered } };
  await Effect.runPromise(dispatchOnboardingEmail(dispatcher));
  await Effect.runPromise(dispatchOnboardingEmail(dispatcher));
  expect(offered).toHaveBeenCalledTimes(1);
  await db.prepare("UPDATE onboarding_email_outbox SET published_at_ms = NULL").run();
  await Effect.runPromise(dispatchOnboardingEmail(dispatcher));
  expect(offered).toHaveBeenCalledTimes(2);
  expect(offered.mock.calls[0]).toEqual(offered.mock.calls[1]);
  expect(offered.mock.calls[0]?.[0]).toMatchObject({ version: 1 });
});

// @effect-diagnostics-next-line asyncFunction:off
it("continues to publish other identities when one Queue offer fails", async () => {
  const { db, send } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  expect(
    (await deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))).status
  ).toBe(200);
  const decisionTime = await advancePastDecisionProof(db);
  expect((await send(inbound("wamid.accept", "Acepto", decisionTime))).status).toBe(200);
  expect(
    (await send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1))))
      .status
  ).toBe(200);
  const secondExchange = "00000000-0000-4000-8000-000000000002";
  const secondToken = "00000000-0000-4000-8000-000000000003";
  const secondEnrollment = "00000000-0000-4000-8000-000000000004";
  await db
    .prepare(`INSERT INTO pending_consent_exchanges
    (id,portfolio_id,bsuid,phone_number_id,initiating_message_id,initiating_body_sha256,
     correlation_token,disclosure_json,disclosure_message_id,created_at_ms,expires_at_ms,state)
    SELECT ?,portfolio_id,?,phone_number_id,?,initiating_body_sha256,?,
      disclosure_json,disclosure_message_id,created_at_ms,expires_at_ms,'outbound_started'
    FROM pending_consent_exchanges LIMIT 1`)
    .bind(secondExchange, "CO.23491208655302741918", "wamid.second-first", secondToken)
    .run();
  await db
    .prepare(`INSERT INTO pending_consent_delivery
    (correlation_token,phone_number_id,message_id,occurred_at_ms,received_at_ms,decision_not_before_ms)
    SELECT ?,phone_number_id,message_id,occurred_at_ms,received_at_ms,decision_not_before_ms
    FROM pending_consent_delivery LIMIT 1`)
    .bind(secondToken)
    .run();
  await db
    .prepare(`INSERT INTO pending_consent_decisions
    (exchange_id,portfolio_id,bsuid,phone_number_id,decision,disclosure_json,disclosure_message_id,
     decision_message_id,delivery_key,body_sha256,occurred_at_ms,received_at_ms)
    SELECT ?,portfolio_id,?,phone_number_id,decision,disclosure_json,disclosure_message_id,
      ?,delivery_key,body_sha256,occurred_at_ms,received_at_ms
    FROM pending_consent_decisions LIMIT 1`)
    .bind(secondExchange, "CO.23491208655302741918", "wamid.second-accept")
    .run();
  await db
    .prepare(`INSERT INTO pending_email_enrollments
    (id,exchange_id,email_address,submission_message_id,submission_body_sha256,created_at_ms,expires_at_ms,state)
    SELECT ?,?,email_address,?,submission_body_sha256,created_at_ms,expires_at_ms,state
    FROM pending_email_enrollments LIMIT 1`)
    .bind(secondEnrollment, secondExchange, "wamid.second-email")
    .run();
  const offered = vi
    .fn()
    .mockRejectedValueOnce(new Error("queue unavailable"))
    .mockResolvedValue(undefined);
  await expect(
    Effect.runPromise(
      dispatchOnboardingEmail({
        DB: db,
        ONBOARDING_EMAIL_QUEUE: { send: offered },
      })
    )
  ).rejects.toBeUndefined();
  expect(offered).toHaveBeenCalledTimes(2);
  const states = await db.prepare("SELECT published_at_ms FROM onboarding_email_outbox").all();
  expect(states.results.filter((row) => row.published_at_ms === null)).toHaveLength(1);
  expect(states.results.filter((row) => row.published_at_ms !== null)).toHaveLength(1);
});

// @effect-diagnostics-next-line asyncFunction:off
it("rejects malformed Queue work before Workflow creation or provider delivery", async () => {
  const { db } = await setup();
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
        // @effect-diagnostics-next-line globalDate:off
        timestamp: new Date(0),
        retry: vi.fn(),
        ack,
      },
    ],
  };
  await Effect.runPromise(
    receiveOnboardingEmail({
      DB: db,
      ONBOARDING_EMAIL_WORKFLOW: { create: created, get: found },
    })(batch)
  );
  expect(ack).toHaveBeenCalledTimes(1);
  expect(created).not.toHaveBeenCalled();
  expect(found).not.toHaveBeenCalled();
  expect((await db.prepare("SELECT * FROM pending_email_enrollments").all()).results).toEqual([]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("starts one deterministic Workflow identity despite Queue redelivery", async () => {
  const { db, send } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  expect(
    (await deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))).status
  ).toBe(200);
  const decisionTime = await advancePastDecisionProof(db);
  expect((await send(inbound("wamid.accept", "Acepto", decisionTime))).status).toBe(200);
  expect(
    (await send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1))))
      .status
  ).toBe(200);
  const row = await db.prepare("SELECT id FROM pending_email_enrollments").first();
  const id = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(row).id;
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
        // @effect-diagnostics-next-line globalDate:off
        timestamp: new Date(0),
        retry: vi.fn(),
        ack,
      },
    ],
  };
  const worker = receiveOnboardingEmail({
    DB: db,
    ONBOARDING_EMAIL_WORKFLOW: { create: createdWorkflow, get: found },
  });
  await Effect.runPromise(worker(batch));
  await Effect.runPromise(worker(batch));
  expect(createdWorkflow).toHaveBeenCalledTimes(2);
  expect(createdWorkflow.mock.calls[0]).toEqual(createdWorkflow.mock.calls[1]);
  expect(createdWorkflow.mock.calls[0]?.[0]).toEqual({ id, params: { version: 1, id } });
  expect(found).toHaveBeenCalledWith(id);
  expect(ack).toHaveBeenCalledTimes(2);
  createdWorkflow.mockRejectedValueOnce(new Error("uncertain start"));
  found.mockRejectedValueOnce(new Error("cannot confirm instance"));
  await expect(Effect.runPromise(worker(batch))).rejects.toBeUndefined();
  expect(ack).toHaveBeenCalledTimes(2);
  await Effect.runPromise(worker(batch));
  expect(createdWorkflow).toHaveBeenCalledTimes(4);
  expect(ack).toHaveBeenCalledTimes(3);
});

// @effect-diagnostics-next-line asyncFunction:off
it("runs the versioned Workflow Activity under replay without repeating provider delivery", async () => {
  const { db, send } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  expect(
    (await deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))).status
  ).toBe(200);
  const decisionTime = await advancePastDecisionProof(db);
  expect((await send(inbound("wamid.accept", "Acepto", decisionTime))).status).toBe(200);
  expect(
    (await send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1))))
      .status
  ).toBe(200);
  const row = await db.prepare("SELECT id FROM pending_email_enrollments").first();
  const id = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(row).id;
  const provider = vi.fn(() => Promise.resolve(Response.json({ id: "resend-message-id" })));
  vi.stubGlobal("fetch", provider);
  const steps: Array<string> = [];
  // A deterministic Step substitute; only the do method is exercised by this Workflow.
  const step: WorkflowStep = Object.create(null);
  Object.defineProperty(step, "do", {
    value: (name: string, _options: unknown, run: () => Promise<void>): Promise<void> => {
      steps.push(name);
      return run();
    },
  });
  // The native ExecutionContext is not used by the test-only Workflow constructor.
  const context: ExecutionContext = Object.create(null);
  const workflow = new OnboardingEmailWorkflowV1(context, {
    DB: db,
    RESEND_API_KEY: "test-provider-key",
  });
  const event: WorkflowEvent<unknown> = {
    payload: { version: 1, id },
    // @effect-diagnostics-next-line globalDate:off
    timestamp: new Date(0),
    instanceId: id,
    workflowName: "OnboardingEmailWorkflowV1",
  };
  await workflow.run(event, step);
  await workflow.run(event, step);
  await workflow.run({ ...event, payload: { version: 2, id } }, step);
  expect(steps).toEqual(["send-onboarding-verification-v1", "send-onboarding-verification-v1"]);
  expect(provider).toHaveBeenCalledTimes(1);
  expect((await db.prepare("SELECT state FROM pending_email_enrollments").first())?.state).toBe(
    "awaiting_proof"
  );
});

// @effect-diagnostics-next-line asyncFunction:off
it("keeps only a digest after one Resend acceptance and cannot send again on Activity replay", async () => {
  const { db, send } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  expect(
    (await deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))).status
  ).toBe(200);
  const decisionTime = await advancePastDecisionProof(db);
  expect((await send(inbound("wamid.accept", "Acepto", decisionTime))).status).toBe(200);
  expect(
    (await send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1))))
      .status
  ).toBe(200);
  const row = await db.prepare("SELECT id FROM pending_email_enrollments").first();
  const id = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(row).id;
  const provider = vi.fn(() => Promise.resolve(Response.json({ id: "email_provider_1" })));
  vi.stubGlobal("fetch", provider);
  await deliverOnboardingEmail({ DB: db, RESEND_API_KEY: "test-provider-key" })(id);
  await deliverOnboardingEmail({ DB: db, RESEND_API_KEY: "test-provider-key" })(id);
  expect(provider).toHaveBeenCalledTimes(1);
  const proof = await db
    .prepare(`SELECT state, public_code, proof_digest, proof_expires_at_ms
    FROM pending_email_enrollments WHERE id = ?`)
    .bind(id)
    .first();
  expect(proof?.state).toBe("awaiting_proof");
  expect(proof?.public_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
  const digest = proof?.proof_digest;
  expect(
    Schema.decodeUnknownSync(
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })))
    )(digest)
  ).toHaveLength(32);
  expect(
    JSON.stringify(await db.prepare("SELECT * FROM onboarding_email_outbox").all())
  ).not.toContain("email_provider_1");
});

// @effect-diagnostics-next-line asyncFunction:off
it("treats malformed Resend acceptance as ambiguous rather than sending another proof", async () => {
  const { db, send } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  expect(
    (await deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))).status
  ).toBe(200);
  const decisionTime = await advancePastDecisionProof(db);
  expect((await send(inbound("wamid.accept", "Acepto", decisionTime))).status).toBe(200);
  expect(
    (await send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1))))
      .status
  ).toBe(200);
  const row = await db.prepare("SELECT id FROM pending_email_enrollments").first();
  const id = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(row).id;
  const provider = vi.fn(() => Promise.resolve(Response.json({ bogus: "not a message id" })));
  vi.stubGlobal("fetch", provider);
  await deliverOnboardingEmail({ DB: db, RESEND_API_KEY: "test-provider-key" })(id);
  await deliverOnboardingEmail({ DB: db, RESEND_API_KEY: "test-provider-key" })(id);
  expect(provider).toHaveBeenCalledTimes(1);
  expect((await db.prepare("SELECT state FROM pending_email_enrollments").first())?.state).toBe(
    "ambiguous"
  );
});

// @effect-diagnostics-next-line asyncFunction:off
it("lets only the accepted WhatsApp caller request a bounded, proof-free delivery status", async () => {
  const { db, send } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  expect(
    (await deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))).status
  ).toBe(200);
  const decisionTime = await advancePastDecisionProof(db);
  expect((await send(inbound("wamid.accept", "Acepto", decisionTime))).status).toBe(200);
  expect(
    (await send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1))))
      .status
  ).toBe(200);
  await db.prepare("UPDATE pending_email_enrollments SET state = 'rejected'").run();
  const provider = vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve(
      Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.status" }] })
    )
  );
  vi.stubGlobal("fetch", provider);
  const status = inbound("wamid.status-request", "Estado", String(Number(decisionTime) + 2));
  expect((await send(status, "invalid-signature")).status).toBe(401);
  expect((await send(status.replaceAll(bsuid, "CO.23491208655302741918"))).status).toBe(409);
  expect((await send(status.replace("123456789012345", "123456789012346"))).status).toBe(409);
  expect(provider).not.toHaveBeenCalled();
  expect((await send(status)).status).toBe(200);
  expect((await send(status)).status).toBe(200);
  expect(provider).toHaveBeenCalledTimes(1);
  const payload = Schema.decodeUnknownSync(
    Schema.Struct({
      text: Schema.Struct({ body: Schema.String }),
    })
  )(JSON.parse(providerBody(provider.mock.calls[0]?.[1])));
  expect(payload.text.body).toContain("rechazó");
  expect(payload.text.body).not.toContain("test@example.com");
  expect(payload.text.body).not.toMatch(/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/u);
  expect(
    (await db.prepare("SELECT email_status_attempts FROM pending_consent_exchanges").first())
      ?.email_status_attempts
  ).toBe(1);
  await db
    .prepare("UPDATE pending_consent_exchanges SET email_status_last_ms = email_status_last_ms - ?")
    .bind(statusCooldownElapsedMs)
    .run();
  await db.prepare("UPDATE pending_email_enrollments SET state = 'ambiguous'").run();
  expect(
    (await send(inbound("wamid.status-uncertain", "Estado", String(Number(decisionTime) + 3))))
      .status
  ).toBe(200);
  expect(provider).toHaveBeenCalledTimes(2);
  const uncertain = Schema.decodeUnknownSync(
    Schema.Struct({
      text: Schema.Struct({ body: Schema.String }),
    })
  )(JSON.parse(providerBody(provider.mock.calls[1]?.[1])));
  expect(uncertain.text.body).toContain("No podemos confirmar");
  expect(uncertain.text.body).not.toContain("test@example.com");
});

// @effect-diagnostics-next-line asyncFunction:off
it("marks an interrupted provider call ambiguous without repeating the send", async () => {
  const { db, send } = await setup();
  const token = await startDisclosure(send);
  const created = await db.prepare("SELECT created_at_ms FROM pending_consent_exchanges").first();
  expect(
    (await deliver(send, token, String(Math.ceil(Number(created?.created_at_ms) / 1000)))).status
  ).toBe(200);
  const decisionTime = await advancePastDecisionProof(db);
  expect((await send(inbound("wamid.accept", "Acepto", decisionTime))).status).toBe(200);
  expect(
    (await send(inbound("wamid.email", "test@example.com", String(Number(decisionTime) + 1))))
      .status
  ).toBe(200);
  const row = await db.prepare("SELECT id FROM pending_email_enrollments").first();
  const id = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(row).id;
  const provider = vi.fn(() => Promise.reject(new Error("connection lost after request")));
  vi.stubGlobal("fetch", provider);
  await deliverOnboardingEmail({ DB: db, RESEND_API_KEY: "test-provider-key" })(id);
  await deliverOnboardingEmail({ DB: db, RESEND_API_KEY: "test-provider-key" })(id);
  expect(provider).toHaveBeenCalledTimes(1);
  expect((await db.prepare("SELECT state FROM pending_email_enrollments").first())?.state).toBe(
    "ambiguous"
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
