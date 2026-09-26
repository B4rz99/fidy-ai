import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { Clock, Effect, Option, Schema } from "effect";
import { currentDisclosureFor } from "@fidy/server/consent-ingress";
import { DisclosureSnapshot, TranscriptText, TranscriptTurnId } from "@fidy/server/agent-runtime";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import type { HostedInferenceService } from "@fidy/server/hosted-inference";
import { makeCloudflareHostedInference } from "../ai/workers-ai";
import { UserTransactionCoordinator } from "../transactions/transaction-coordinator";
import { newId } from "../pats/pat-shared";
import { acknowledgeBrowserTurn, browserHostedDelivery, completeHostedTurn } from "./hosted-turn";
import type { HostedDelivery } from "./hosted-turn";

const users = [
  "10000000-0000-4000-8000-000000000071",
  "10000000-0000-4000-8000-000000000072",
] as const;
const sessions = [
  "10000000-0000-4000-8000-000000000081",
  "10000000-0000-4000-8000-000000000082",
] as const;
const pairings = [
  "10000000-0000-4000-8000-000000000091",
  "10000000-0000-4000-8000-000000000092",
] as const;
const grants = [
  "10000000-0000-4000-8000-000000000101",
  "10000000-0000-4000-8000-000000000102",
] as const;
const models: Array<Miniflare> = [];
let sequence = 0;
const now = (): number => Effect.runSync(Clock.currentTimeMillis);
const digest = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((result) => new Uint8Array(result));
const bearer = (index: number): string => String(index + 1).repeat(43);
const applyMigration = (db: D1Database, name: string): Promise<void> =>
  Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url))
    .text()
    .then((sql) =>
      sql
        .replace(/^--.*$/gmu, "")
        .trim()
        .split(/;\s*\n(?=CREATE |ALTER |INSERT |DROP |$)/u)
        .reduce<Promise<void>>(
          (previous, statement) =>
            previous.then(() => db.prepare(statement).run()).then(() => undefined),
          Promise.resolve()
        )
    );
const migrationNames = [
  "0001_categories",
  "0003_pending_consent",
  "0004_onboarding_email",
  "0005_verified_onboarding",
  "0006_browser_login",
  "0009_transactions",
  "0010_pat_lifecycle",
  "0011_transaction_corrections",
  "0012_statement_staging",
  "0012_transaction_search",
  "0013_category_keyword_rules",
  "0013_transaction_reconciliation",
  "0014_memory",
  "0015_statement_submission",
  "0016_hosted_turn",
] as const;
// @effect-diagnostics-next-line asyncFunction:off
const setup = async (): Promise<D1Database> => {
  const name = `hosted-turn-${++sequence}`;
  const mf = new Miniflare({
    workers: [
      {
        config: {
          compatibilityDate: "2026-09-08",
          env: { DB: { id: name, type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default {fetch(){return new Response('ok')}}",
                type: "esm",
              },
            },
          },
          name,
          type: "worker",
        },
      },
    ],
  });
  models.push(mf);
  await mf.ready;
  const db = await mf.getD1Database("DB");
  await migrationNames.reduce<Promise<void>>(
    (previous, migration) => previous.then(() => applyMigration(db, migration)),
    Promise.resolve()
  );
  // The stored disclosure is generated from the same canonical snapshot onboarding retains.
  const snapshot = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot)))(
    currentDisclosureFor()
  );
  const timestamp = now();
  await Promise.all(
    // @effect-diagnostics-next-line asyncFunction:off
    [0, 1].map(async (index): Promise<void> => {
      const user = users[index];
      const pairing = pairings[index];
      const session = sessions[index];
      const grant = grants[index];
      if (
        user === undefined ||
        pairing === undefined ||
        session === undefined ||
        grant === undefined
      ) {
        throw Error("fixture");
      }
      await db
        .prepare(
          "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
        )
        .bind(user, timestamp)
        .run();
      await db
        .prepare(
          "INSERT INTO onboarding_consent_records (id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, accepted_at_ms) VALUES (?, ?, ?, 'disclosed', 'accepted', ?, ?)"
        )
        .bind(grant, user, snapshot, timestamp, timestamp)
        .run();
      await db
        .prepare(
          "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'consumed', ?, ?)"
        )
        .bind(
          pairing,
          `BCDF-GHJ${index}`,
          await digest(`verifier${index}`),
          user,
          timestamp - 1_000,
          timestamp + 599_000
        )
        .run();
      await db
        .prepare(
          "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(
          session,
          pairing,
          user,
          await digest(bearer(index)),
          timestamp,
          timestamp + 600_000,
          timestamp + 3_600_000,
          timestamp + 7_776_000_000
        )
        .run();
    })
  );
  return db;
};
// @effect-diagnostics-next-line asyncFunction:off
const subject = async (
  index: number
): Promise<{ userId: string; id: string; digest: Uint8Array }> => ({
  userId: users[index] ?? "",
  id: sessions[index] ?? "",
  digest: await digest(bearer(index)),
});
const reply = (content: unknown = "Listo"): Response =>
  Response.json({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
  });
const inference = (run: (request: unknown) => Promise<Response>): Promise<HostedInferenceService> =>
  Effect.runPromise(
    makeCloudflareHostedInference({
      AI: { run: (_model, request) => run(request) },
      HOSTED_AI_MODEL: approvedWorkersAiModel,
    })
  );
const retained = (db: D1Database, user: string): Promise<D1Result> =>
  db
    .prepare(`SELECT t.status, t.failure_reason, e.kind, e.text, e.failure_reason AS marker
  FROM hosted_turns AS t JOIN transcript_entries AS e ON e.turn_id = t.id
  WHERE t.user_id = ? ORDER BY e.sequence`)
    .bind(user)
    .all();

const VisibleReply = Schema.Struct({
  text: TranscriptText,
  turnId: TranscriptTurnId,
  receipt: Schema.String,
});
// @effect-diagnostics-next-line asyncFunction:off
const acknowledgeVisibleReply = async (
  db: D1Database,
  index: number,
  response: Response
): Promise<string> => {
  expect(response.status).toBe(202);
  const visible = Schema.decodeUnknownSync(VisibleReply)(await response.json());
  const confirmation = await acknowledgeBrowserTurn({
    db,
    subject: await subject(index),
    turnId: visible.turnId,
    receipt: visible.receipt,
  });
  expect(confirmation.status).toBe(200);
  return visible.text;
};

// @effect-diagnostics-next-line asyncFunction:off
afterEach(async () => {
  await Promise.all(models.splice(0).map((model) => model.dispose()));
});

// @effect-diagnostics-next-line asyncFunction:off
it("delivers a no-tool Workers AI reply and retains exact User and assistant evidence before completion", async () => {
  const db = await setup();
  const model = await inference(() => Promise.resolve(reply("Respuesta exacta")));
  const response = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Hola"),
    inference: model,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  expect((await retained(db, users[0])).results).toMatchObject([
    { status: "pending", kind: "user", text: "Hola" },
  ]);
  expect(await acknowledgeVisibleReply(db, 0, response)).toBe("Respuesta exacta");
  expect((await retained(db, users[0])).results).toMatchObject([
    { status: "completed", kind: "user", text: "Hola" },
    { status: "completed", kind: "assistant", text: "Respuesta exacta" },
  ]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("prepares current evidence only for its User and session, never mixing a second User's text", async () => {
  const db = await setup();
  const prompts: Array<unknown> = [];
  const model = await inference((request) => {
    prompts.push(request);
    return Promise.resolve(reply());
  });
  const send = (index: number): Promise<void> =>
    subject(index)
      .then((credential) =>
        completeHostedTurn({
          db,
          subject: credential,
          text: TranscriptText.make(index === 0 ? "private-A" : "private-B"),
          inference: model,
          deliver: browserHostedDelivery,
          signal: new AbortController().signal,
        })
      )
      .then((output) => acknowledgeVisibleReply(db, index, output))
      .then(() => undefined);
  await [0, 1, 0].reduce<Promise<void>>(
    (previous, index) => previous.then(() => send(index)),
    Promise.resolve()
  );
  const serialized = prompts.map((prompt) => JSON.stringify(prompt));
  expect(serialized[2]).toContain("private-A");
  expect(serialized[2]).not.toContain("private-B");
  expect(serialized[1]).not.toContain("private-A");
  expect((await retained(db, users[0])).results).toHaveLength(4);
  expect((await retained(db, users[1])).results).toHaveLength(2);
});

// @effect-diagnostics-next-line asyncFunction:off
it("never retains invalid output as an assistant reply and records delivery failure without text", async () => {
  const db = await setup();
  const invalidModel = await inference(() => Promise.resolve(reply("")));
  const invalid = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Invalid"),
    inference: invalidModel,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  expect(invalid.status).toBe(503);
  expect((await retained(db, users[0])).results).toMatchObject([
    { status: "failed", kind: "user", text: "Invalid" },
    { status: "failed", kind: "failed", text: null, marker: "HostedInferenceFailed" },
  ]);
  const model = await inference(() => Promise.resolve(reply("Secret answer")));
  const notDelivered: HostedDelivery = () => Promise.reject(new Error("channel closed"));
  const failure = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Delivery"),
    inference: model,
    deliver: notDelivered,
    signal: new AbortController().signal,
  });
  expect(failure.status).toBe(503);
  expect((await retained(db, users[0])).results).toMatchObject([
    {},
    {},
    { status: "failed", kind: "user", text: "Delivery" },
    { status: "failed", kind: "failed", text: null, marker: "DeliveryFailed" },
  ]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("recovers abandoned Pending once, then refuses new work after Consent withdrawal", async () => {
  const db = await setup();
  const model = await inference(() => Promise.resolve(reply()));
  const initial = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Before"),
    inference: model,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, initial);
  const existing = await db
    .prepare("SELECT id, hosted_session_id FROM hosted_turns WHERE user_id = ?")
    .bind(users[0])
    .first<{ id: string; hosted_session_id: string }>();
  if (existing === null) throw Error("missing Turn");
  const pending = "10000000-0000-4000-8000-000000000190";
  const timestamp = now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO hosted_turns (id, user_id, hosted_session_id, status, started_at_ms) VALUES (?, ?, ?, 'pending', ?)"
      )
      .bind(pending, users[0], existing.hosted_session_id, timestamp),
    db
      .prepare(
        "INSERT INTO transcript_entries (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text) VALUES (?, ?, ?, ?, 'user', ?, 'Abandoned')"
      )
      .bind(
        "10000000-0000-4000-8000-000000000191",
        users[0],
        existing.hosted_session_id,
        pending,
        timestamp
      ),
  ]);
  await db
    .prepare(`INSERT INTO hosted_delivery_proposals
    (turn_id, user_id, receipt_digest, proposed_at_ms, text) VALUES (?, ?, ?, ?, ?)`)
    .bind(pending, users[0], new Uint8Array(32), timestamp - 121_000, "Unacknowledged answer")
    .run();
  await db
    .prepare(
      "INSERT INTO consent_user_revocations (id, user_id, grant_record_id, session_id, occurred_at_ms) VALUES (?, ?, ?, ?, ?)"
    )
    .bind("10000000-0000-4000-8000-000000000192", users[0], grants[0], sessions[0], timestamp)
    .run();
  const blocked = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("After"),
    inference: model,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  expect(blocked.status).toBe(403);
  const rows = (await retained(db, users[0])).results;
  expect(rows).toMatchObject([
    { status: "completed", kind: "user" },
    { status: "completed", kind: "assistant" },
    { status: "interrupted", kind: "user", text: "Abandoned" },
    { status: "interrupted", kind: "interrupted", text: null },
  ]);
  expect(rows).toHaveLength(4);
  expect(
    (
      await db
        .prepare("SELECT turn_id FROM hosted_delivery_proposals WHERE user_id = ?")
        .bind(users[0])
        .all()
    ).results
  ).toHaveLength(0);
});

// @effect-diagnostics-next-line asyncFunction:off
it("serializes concurrent requests at the per-User coordinator and admits two distinct Turns", async () => {
  const db = await setup();
  let release: () => void = () => undefined;
  let announce: () => void = () => undefined;
  // @effect-diagnostics-next-line newPromise:off
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  // @effect-diagnostics-next-line newPromise:off
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  const environment: ConstructorParameters<typeof UserTransactionCoordinator>[1] = {
    DB: db,
    STATEMENT_STAGING_BUCKET: Option.none(),
    HOSTED_AI_MODEL: approvedWorkersAiModel,
    AI: {
      run: () => {
        count++;
        if (count === 1) {
          announce();
          return wait.then(() => reply("First"));
        }
        return Promise.resolve(reply("Second"));
      },
    },
  };
  const coordinator = new UserTransactionCoordinator({ id: { name: users[0] } }, environment);
  const credentials = await subject(0);
  const send = (text: string): Promise<Response> =>
    coordinator.fetch(
      new Request("https://coordinator.internal/hosted-turn", {
        method: "POST",
        body: JSON.stringify({
          userId: credentials.userId,
          sessionId: credentials.id,
          digest: Array.from(credentials.digest),
          text,
        }),
      })
    );
  const first = send("One");
  await entered;
  const second = send("Two");
  expect(count).toBe(1);
  release();
  const firstReply = await first;
  const blocked = await second;
  expect(blocked.status).toBe(409);
  expect(count).toBe(1);
  const visible = Schema.decodeUnknownSync(VisibleReply)(await firstReply.json());
  const acknowledged = await coordinator.fetch(
    new Request("https://coordinator.internal/hosted-turn/receipt", {
      method: "POST",
      body: JSON.stringify({
        userId: credentials.userId,
        sessionId: credentials.id,
        digest: Array.from(credentials.digest),
        turnId: visible.turnId,
        receipt: visible.receipt,
      }),
    })
  );
  expect(acknowledged.status).toBe(200);
  const third = await send("Two");
  expect(await acknowledgeVisibleReply(db, 0, third)).toBe("Second");
  expect(count).toBe(2);
  expect((await retained(db, users[0])).results).toMatchObject([
    { status: "completed", kind: "user", text: "One" },
    { status: "completed", kind: "assistant", text: "First" },
    { status: "completed", kind: "user", text: "Two" },
    { status: "completed", kind: "assistant", text: "Second" },
  ]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("checks the durable daily allowance before provider preparation or new evidence", async () => {
  const db = await setup();
  let calls = 0;
  const model = await inference(() => {
    calls++;
    return Promise.resolve(reply());
  });
  const first = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Initial"),
    inference: model,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, first);
  const session = await db
    .prepare("SELECT hosted_session_id FROM hosted_turns WHERE user_id = ?")
    .bind(users[0])
    .first<{ hosted_session_id: string }>();
  if (session === null) throw Error("missing Hosted Agent Session");
  const timestamp = now();
  const addTerminalTurn = (index: number): Promise<unknown> => {
    const turn = newId();
    return db.batch([
      db
        .prepare(
          "INSERT INTO hosted_turns (id, user_id, hosted_session_id, status, started_at_ms) VALUES (?, ?, ?, 'pending', ?)"
        )
        .bind(turn, users[0], session.hosted_session_id, timestamp),
      db
        .prepare(
          "INSERT INTO transcript_entries (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text) VALUES (?, ?, ?, ?, 'user', ?, ?)"
        )
        .bind(newId(), users[0], session.hosted_session_id, turn, timestamp, `Budget ${index}`),
      db
        .prepare(
          "INSERT INTO transcript_entries (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, failure_reason) VALUES (?, ?, ?, ?, 'failed', ?, 'HostedInferenceFailed')"
        )
        .bind(newId(), users[0], session.hosted_session_id, turn, timestamp),
      db
        .prepare(
          "UPDATE hosted_turns SET status = 'failed', terminal_at_ms = ?, failure_reason = 'HostedInferenceFailed' WHERE id = ?"
        )
        .bind(timestamp, turn),
    ]);
  };
  await Array.from({ length: 49 }, (_, index) => index).reduce<Promise<unknown>>(
    (previous, index) => previous.then(() => addTerminalTurn(index)),
    Promise.resolve()
  );
  const overQuota = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Over quota"),
    inference: model,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  expect(overQuota.status).toBe(429);
  expect(calls).toBe(1);
  expect((await retained(db, users[0])).results).toHaveLength(100);
});

// @effect-diagnostics-next-line asyncFunction:off
it("refuses stale credentials and cross-User proofs before retaining or sending context", async () => {
  const db = await setup();
  let sends = 0;
  const model = await inference(() => {
    sends++;
    return Promise.resolve(reply());
  });
  const stolen = { ...(await subject(0)), userId: users[1] };
  const mismatch = await completeHostedTurn({
    db,
    subject: stolen,
    text: TranscriptText.make("Untrusted"),
    inference: model,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  expect(mismatch.status).toBe(401);
  await db
    .prepare("UPDATE web_sessions SET idle_expires_at_ms = ? WHERE id = ?")
    .bind(now() - 1, sessions[0])
    .run();
  const stale = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Expired"),
    inference: model,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  expect(stale.status).toBe(401);
  expect(sends).toBe(0);
  expect((await retained(db, users[0])).results).toHaveLength(0);
  expect((await retained(db, users[1])).results).toHaveLength(0);
});

// @effect-diagnostics-next-line asyncFunction:off
it("interrupts in-flight work with only a metadata marker and recovers without provider output", async () => {
  const db = await setup();
  const controller = new AbortController();
  let entered = false;
  const model = await inference(() => {
    entered = true;
    controller.abort();
    return Promise.reject(new Error("aborted"));
  });
  const work = completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Interrupted request"),
    inference: model,
    deliver: browserHostedDelivery,
    signal: controller.signal,
  });
  expect((await work).status).toBe(503);
  expect(entered).toBe(true);
  expect((await retained(db, users[0])).results).toMatchObject([
    { status: "interrupted", kind: "user", text: "Interrupted request" },
    { status: "interrupted", kind: "interrupted", text: null, marker: null },
  ]);
});
