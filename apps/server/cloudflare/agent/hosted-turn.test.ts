import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { Clock, Effect, Option, Schema } from "effect";
import { currentDisclosureFor } from "@fidy/server/consent-ingress";
import {
  DisclosureSnapshot,
  HostedAgentSessionId,
  TranscriptText,
  TranscriptTurnId,
} from "@fidy/server/agent-runtime";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import type { HostedInferenceService } from "@fidy/server/hosted-inference";
import { makeCloudflareHostedInference } from "../ai/workers-ai";
import { UserTransactionCoordinator } from "../transactions/transaction-coordinator";
import { newId } from "../pats/pat-shared";
import {
  commitHostedCompaction,
  hostedTranscriptRetentionMs,
  readHostedContinuity,
} from "./turn-store";
import { sweepHostedTurns } from "./hosted-turn-sweep";
import {
  acknowledgeBrowserTurn,
  browserHostedDelivery,
  completeHostedTurn as completeHostedTurnWithAlarm,
} from "./hosted-turn";
import type { HostedDelivery } from "./hosted-turn";

const completeHostedTurn = (
  input: Omit<Parameters<typeof completeHostedTurnWithAlarm>[0], "scheduleRecovery">
): Promise<Response> =>
  completeHostedTurnWithAlarm({ ...input, scheduleRecovery: () => Promise.resolve() });

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
  "0017_hosted_compaction",
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
it("replaces only a terminal prefix and preserves exact Failed evidence when a stale attempt loses", async () => {
  const db = await setup();
  const model = await inference(() => Promise.resolve(reply()));
  const first = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Exact User words"),
    inference: model,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, first);
  const failed = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Failed User words"),
    inference: await inference(() => Promise.resolve(reply(""))),
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  expect(failed.status).toBe(503);
  const session = await db
    .prepare("SELECT id FROM hosted_agent_sessions WHERE user_id = ?")
    .bind(users[0])
    .first<{ id: string }>();
  if (session === null) throw Error("missing session");
  const credential = await subject(0);
  const initial = await readHostedContinuity({
    db,
    subject: credential,
    sessionId: Schema.decodeSync(HostedAgentSessionId)(session.id),
    now: now(),
  });
  expect(initial.transcript.map(({ entry }) => entry._tag)).toEqual([
    "UserTranscriptEntry",
    "AssistantTranscriptEntry",
    "UserTranscriptEntry",
    "FailedTurnTranscriptEntry",
  ]);
  const cursor = initial.terminalThroughSequence;
  if (Option.isNone(cursor)) throw Error("missing terminal prefix");
  const input = {
    db,
    subject: credential,
    sessionId: Schema.decodeSync(HostedAgentSessionId)(session.id),
    continuity: initial,
    throughSequence: cursor.value,
    signal: new AbortController().signal,
  };
  const aborted = new AbortController();
  aborted.abort();
  expect(
    await commitHostedCompaction({ ...input, signal: aborted.signal, text: "Interrupted" })
  ).toBe(false);
  expect((await retained(db, users[0])).results).toHaveLength(4);
  const firstEntry = initial.transcript[0];
  if (firstEntry === undefined) throw Error("missing first entry");
  expect(
    await commitHostedCompaction({
      ...input,
      throughSequence: Number(firstEntry.sequence),
      text: "Partial",
    })
  ).toBe(false);
  expect((await retained(db, users[0])).results).toHaveLength(4);
  expect(await commitHostedCompaction({ ...input, text: "Fiel" })).toBe(true);
  expect(await commitHostedCompaction({ ...input, text: "Stale" })).toBe(false);
  const after = await readHostedContinuity({
    db,
    subject: credential,
    sessionId: input.sessionId,
    now: now(),
  });
  expect(after.transcript).toHaveLength(0);
  expect(Option.map(after.compactedConversation, ({ text }) => text)).toEqual(Option.some("Fiel"));
  const next = await completeHostedTurn({
    db,
    subject: credential,
    text: TranscriptText.make("Next"),
    inference: model,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, next);
  expect((await retained(db, users[0])).results).toMatchObject([
    { kind: "user", text: "Next" },
    { kind: "assistant", text: "Listo" },
  ]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("uses a bounded replacement in the next WorkingContext while retaining newer exact Turns", async () => {
  const db = await setup();
  const firstModel = await inference(() => Promise.resolve(reply("Primera")));
  const first = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Uno"),
    inference: firstModel,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, first);
  let calls = 0;
  const compacting = await inference(() =>
    Promise.resolve(
      reply(++calls === 1 ? '{"compactedConversation":"Continuidad fiel"}' : "Segunda")
    )
  );
  const model: HostedInferenceService = {
    ...compacting,
    countTranscript: () => Effect.succeed(100_001),
  };
  const second = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Dos"),
    inference: model,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, second);
  expect((await retained(db, users[0])).results).toMatchObject([
    { kind: "user", text: "Dos" },
    { kind: "assistant", text: "Segunda" },
  ]);
  const nextRequests: Array<unknown> = [];
  const nextModel = await inference((request) => {
    nextRequests.push(request);
    return Promise.resolve(reply("Tercera"));
  });
  const third = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Tres"),
    inference: nextModel,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, third);
  const context = JSON.stringify(nextRequests);
  expect(context).toContain("Continuidad fiel");
  expect(context).toContain("Dos");
  expect(context).not.toContain("Uno");
});

// @effect-diagnostics-next-line asyncFunction:off
it("rejects malformed Compaction output without removing exact evidence or prior continuity", async () => {
  const db = await setup();
  const first = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("First exact"),
    inference: await inference(() => Promise.resolve(reply())),
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, first);
  const session = await db
    .prepare("SELECT id FROM hosted_agent_sessions WHERE user_id = ?")
    .bind(users[0])
    .first<{ id: string }>();
  if (session === null) throw Error("missing session");
  const credential = await subject(0);
  const sessionId = Schema.decodeSync(HostedAgentSessionId)(session.id);
  const firstEvidence = await readHostedContinuity({
    db,
    subject: credential,
    sessionId,
    now: now(),
  });
  const firstCursor = firstEvidence.terminalThroughSequence;
  if (Option.isNone(firstCursor)) throw Error("missing prefix");
  expect(
    await commitHostedCompaction({
      db,
      subject: credential,
      sessionId,
      continuity: firstEvidence,
      throughSequence: firstCursor.value,
      text: "Prior continuity",
      signal: new AbortController().signal,
    })
  ).toBe(true);
  const second = await completeHostedTurn({
    db,
    subject: credential,
    text: TranscriptText.make("Second exact"),
    inference: await inference(() => Promise.resolve(reply("Second answer"))),
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, second);
  let calls = 0;
  const provider = await inference(() =>
    Promise.resolve(reply(++calls === 1 ? '{"compactedConversation":""}' : "Third answer"))
  );
  const model: HostedInferenceService = {
    ...provider,
    countTranscript: () => Effect.succeed(100_001),
  };
  const third = await completeHostedTurn({
    db,
    subject: credential,
    text: TranscriptText.make("Third exact"),
    inference: model,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  expect(await acknowledgeVisibleReply(db, 0, third)).toBe("Third answer");
  const after = await readHostedContinuity({ db, subject: credential, sessionId, now: now() });
  expect(Option.map(after.compactedConversation, ({ text }) => text)).toEqual(
    Option.some("Prior continuity")
  );
  expect(after.transcript.map(({ entry }) => entry._tag)).toEqual([
    "UserTranscriptEntry",
    "AssistantTranscriptEntry",
    "UserTranscriptEntry",
    "AssistantTranscriptEntry",
  ]);
  expect((await retained(db, users[0])).results).toMatchObject([
    { kind: "user", text: "Second exact" },
    { kind: "assistant", text: "Second answer" },
    { kind: "user", text: "Third exact" },
    { kind: "assistant", text: "Third answer" },
  ]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("does not replace continuity when Consent is revoked during Compaction generation", async () => {
  const db = await setup();
  const first = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Private exact words"),
    inference: await inference(() => Promise.resolve(reply())),
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, first);
  const before = (await retained(db, users[0])).results;
  const provider = await inference(() =>
    db
      .prepare(`INSERT INTO consent_user_revocations
    (id, user_id, grant_record_id, session_id, occurred_at_ms) VALUES (?, ?, ?, ?, ?)`)
      .bind(newId(), users[0], grants[0], sessions[0], now())
      .run()
      .then(() => reply('{"compactedConversation":"Forbidden"}'))
  );
  const model: HostedInferenceService = {
    ...provider,
    countTranscript: () => Effect.succeed(100_001),
  };
  const refused = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Denied"),
    inference: model,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect((await retained(db, users[0])).results).toEqual(before);
  const compacted = await db
    .prepare("SELECT text FROM hosted_compacted_conversations WHERE user_id = ?")
    .bind(users[0])
    .all();
  expect(compacted.results).toHaveLength(0);
});

// @effect-diagnostics-next-line asyncFunction:off
it("charges aborted pre-admission Compaction attempts against one User's daily capacity", async () => {
  const db = await setup();
  const first = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Retain me"),
    inference: await inference(() => Promise.resolve(reply())),
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, first);
  let providerCalls = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const abortedAttempt = attempt < 3;
    const provider = await inference(() => {
      providerCalls++;
      if (abortedAttempt) controller.abort();
      return Promise.resolve(
        reply(abortedAttempt ? '{"compactedConversation":"Unused"}' : "Available")
      );
    });
    const model: HostedInferenceService = {
      ...provider,
      countTranscript: () => Effect.succeed(100_001),
    };
    const result = await completeHostedTurn({
      db,
      subject: await subject(0),
      text: TranscriptText.make(`Attempt ${attempt}`),
      inference: model,
      deliver: browserHostedDelivery,
      signal: controller.signal,
    });
    if (abortedAttempt) {
      expect(result.status).toBe(503);
    } else {
      expect(await acknowledgeVisibleReply(db, 0, result)).toBe("Available");
    }
  }
  expect(providerCalls).toBe(4);
  expect((await retained(db, users[0])).results).toMatchObject([
    { kind: "user", text: "Retain me" },
    { kind: "assistant", text: "Listo" },
    { kind: "user", text: "Attempt 3" },
    { kind: "assistant", text: "Available" },
  ]);
  const attempts = await db
    .prepare("SELECT used FROM hosted_compaction_attempts WHERE user_id = ?")
    .bind(users[0])
    .first<{ used: number }>();
  expect(attempts?.used).toBe(3);
});

// @effect-diagnostics-next-line asyncFunction:off
it("compacts a long session of short Turns before its exact-entry capacity is reached", async () => {
  const db = await setup();
  const first = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Start"),
    inference: await inference(() => Promise.resolve(reply())),
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, first);
  const session = await db
    .prepare("SELECT id FROM hosted_agent_sessions WHERE user_id = ?")
    .bind(users[0])
    .first<{ id: string }>();
  if (session === null) throw Error("missing session");
  for (let index = 0; index < 39; index++) {
    const turnId = newId();
    const timestamp = now();
    await db.batch([
      db
        .prepare(`INSERT INTO hosted_turns (id, user_id, hosted_session_id, started_at_ms, status)
        VALUES (?, ?, ?, ?, 'pending')`)
        .bind(turnId, users[0], session.id, timestamp),
      db
        .prepare(`INSERT INTO transcript_entries
        (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text)
        VALUES (?, ?, ?, ?, 'user', ?, 'Short')`)
        .bind(newId(), users[0], session.id, turnId, timestamp),
      db
        .prepare(`INSERT INTO transcript_entries
        (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, failure_reason)
        VALUES (?, ?, ?, ?, 'failed', ?, 'HostedInferenceFailed')`)
        .bind(newId(), users[0], session.id, turnId, timestamp),
      db
        .prepare(`UPDATE hosted_turns SET status = 'failed', terminal_at_ms = ?,
        failure_reason = 'HostedInferenceFailed' WHERE id = ?`)
        .bind(timestamp, turnId),
    ]);
  }
  let calls = 0;
  const provider = await inference(() =>
    Promise.resolve(reply(++calls === 1 ? '{"compactedConversation":"Short history"}' : "Ready"))
  );
  const response = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Continue"),
    inference: provider,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  expect(await acknowledgeVisibleReply(db, 0, response)).toBe("Ready");
  expect((await retained(db, users[0])).results).toMatchObject([
    { kind: "user", text: "Continue" },
    { kind: "assistant", text: "Ready" },
  ]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("expires old CompactedConversation content without exposing it in a later WorkingContext", async () => {
  const db = await setup();
  const first = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Private old words"),
    inference: await inference(() => Promise.resolve(reply())),
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, first);
  const session = await db
    .prepare("SELECT id FROM hosted_agent_sessions WHERE user_id = ?")
    .bind(users[0])
    .first<{ id: string }>();
  if (session === null) throw Error("missing session");
  const credential = await subject(0);
  const sessionId = Schema.decodeSync(HostedAgentSessionId)(session.id);
  const initial = await readHostedContinuity({ db, subject: credential, sessionId, now: now() });
  const cursor = initial.terminalThroughSequence;
  if (Option.isNone(cursor)) throw Error("missing prefix");
  expect(
    await commitHostedCompaction({
      db,
      subject: credential,
      sessionId,
      continuity: initial,
      throughSequence: cursor.value,
      text: "Old private continuity",
      signal: new AbortController().signal,
    })
  ).toBe(true);
  await db
    .prepare(`UPDATE hosted_compacted_conversations SET updated_at_ms = ?
    WHERE user_id = ? AND hosted_session_id = ?`)
    .bind(now() - hostedTranscriptRetentionMs - 10_000, users[0], sessionId)
    .run();
  const before = await readHostedContinuity({ db, subject: credential, sessionId, now: now() });
  expect(Option.isNone(before.compactedConversation)).toBe(true);
  await sweepHostedTurns(db, now());
  const after = await db
    .prepare("SELECT text FROM hosted_compacted_conversations WHERE user_id = ?")
    .bind(users[0])
    .all();
  expect(after.results).toHaveLength(0);
  const requests: Array<unknown> = [];
  const model = await inference((request) => {
    requests.push(request);
    return Promise.resolve(reply());
  });
  const next = await completeHostedTurn({
    db,
    subject: credential,
    text: TranscriptText.make("New"),
    inference: model,
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, next);
  expect(JSON.stringify(requests)).not.toContain("Old private continuity");
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
it("recovers an abandoned staged reply by durable alarm without another User request", async () => {
  const db = await setup();
  const first = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("First"),
    inference: await inference(() => Promise.resolve(reply())),
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, first);
  const existing = await db
    .prepare("SELECT hosted_session_id FROM hosted_turns WHERE user_id = ?")
    .bind(users[0])
    .first<{ hosted_session_id: string }>();
  if (existing === null) throw Error("missing session");
  const id = "10000000-0000-4000-8000-000000000195";
  const timestamp = now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO hosted_turns (id, user_id, hosted_session_id, status, started_at_ms) VALUES (?, ?, ?, 'pending', ?)"
      )
      .bind(id, users[0], existing.hosted_session_id, timestamp),
    db
      .prepare(
        "INSERT INTO transcript_entries (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text) VALUES (?, ?, ?, ?, 'user', ?, 'Never acknowledged')"
      )
      .bind(
        "10000000-0000-4000-8000-000000000196",
        users[0],
        existing.hosted_session_id,
        id,
        timestamp
      ),
    db
      .prepare(
        "INSERT INTO hosted_delivery_proposals (turn_id, user_id, receipt_digest, proposed_at_ms, text) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(id, users[0], new Uint8Array(32), timestamp - 121_000, "Undelivered"),
  ]);
  const scheduled: Array<number | Date> = [];
  const coordinator = new UserTransactionCoordinator(
    {
      id: { name: users[0] },
      storage: {
        setAlarm: (due): Promise<void> => {
          scheduled.push(due);
          return Promise.resolve();
        },
      },
    },
    {
      DB: db,
      STATEMENT_STAGING_BUCKET: undefined,
      HOSTED_AI_MODEL: approvedWorkersAiModel,
      AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
    }
  );
  await coordinator.alarm();
  expect(scheduled).toHaveLength(1);
  expect((await retained(db, users[0])).results.slice(-2)).toMatchObject([
    { kind: "user", status: "interrupted" },
    { kind: "interrupted", status: "interrupted" },
  ]);
  expect(
    (
      await db
        .prepare("SELECT turn_id FROM hosted_delivery_proposals WHERE turn_id = ?")
        .bind(id)
        .all()
    ).results
  ).toHaveLength(0);
  await coordinator.alarm();
  expect((await retained(db, users[0])).results).toHaveLength(4);
});

// @effect-diagnostics-next-line asyncFunction:off
it("allows only the timed User-scoped retention sweep to remove old terminal evidence", async () => {
  const db = await setup();
  const first = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Recent"),
    inference: await inference(() => Promise.resolve(reply())),
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, first);
  const session = await db
    .prepare("SELECT hosted_session_id FROM hosted_turns WHERE user_id = ?")
    .bind(users[0])
    .first<{ hosted_session_id: string }>();
  if (session === null) throw Error("missing session");
  const id = "10000000-0000-4000-8000-000000000197";
  const old = now() - hostedTranscriptRetentionMs - 10_000;
  await db.batch([
    db
      .prepare(
        "INSERT INTO hosted_turns (id, user_id, hosted_session_id, status, started_at_ms) VALUES (?, ?, ?, 'pending', ?)"
      )
      .bind(id, users[0], session.hosted_session_id, old),
    db
      .prepare(
        "INSERT INTO transcript_entries (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text) VALUES (?, ?, ?, ?, 'user', ?, 'Old private text')"
      )
      .bind("10000000-0000-4000-8000-000000000198", users[0], session.hosted_session_id, id, old),
    db
      .prepare(
        "INSERT INTO transcript_entries (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, failure_reason) VALUES (?, ?, ?, ?, 'failed', ?, 'HostedInferenceFailed')"
      )
      .bind(
        "10000000-0000-4000-8000-000000000199",
        users[0],
        session.hosted_session_id,
        id,
        old + 1
      ),
    db
      .prepare(
        "UPDATE hosted_turns SET status = 'failed', terminal_at_ms = ?, failure_reason = 'HostedInferenceFailed' WHERE id = ?"
      )
      .bind(old + 1, id),
  ]);
  await expect(
    db.prepare("DELETE FROM transcript_entries WHERE user_id = ?").bind(users[0]).run()
  ).rejects.toThrow();
  await sweepHostedTurns(db, now());
  expect(
    (await db.prepare("SELECT kind FROM transcript_entries WHERE turn_id = ?").bind(id).all())
      .results
  ).toHaveLength(0);
  expect(
    (await db.prepare("SELECT kind FROM transcript_entries WHERE user_id = ?").bind(users[0]).all())
      .results
  ).toHaveLength(2);
  expect(await db.prepare("SELECT status FROM hosted_turns WHERE id = ?").bind(id).first()).toEqual(
    { status: "failed" }
  );
});

// @effect-diagnostics-next-line asyncFunction:off
it("retains the complete Turn until thirty days after its terminal marker", async () => {
  const db = await setup();
  const first = await completeHostedTurn({
    db,
    subject: await subject(0),
    text: TranscriptText.make("Current"),
    inference: await inference(() => Promise.resolve(reply())),
    deliver: browserHostedDelivery,
    signal: new AbortController().signal,
  });
  await acknowledgeVisibleReply(db, 0, first);
  const session = await db
    .prepare("SELECT hosted_session_id FROM hosted_turns WHERE user_id = ?")
    .bind(users[0])
    .first<{ hosted_session_id: string }>();
  if (session === null) throw Error("missing session");
  const id = "10000000-0000-4000-8000-000000000193";
  const old = now() - hostedTranscriptRetentionMs - 10_000;
  const recent = now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO hosted_turns (id, user_id, hosted_session_id, status, started_at_ms) VALUES (?, ?, ?, 'pending', ?)"
      )
      .bind(id, users[0], session.hosted_session_id, old),
    db
      .prepare(
        "INSERT INTO transcript_entries (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text) VALUES (?, ?, ?, ?, 'user', ?, 'Old User content')"
      )
      .bind("10000000-0000-4000-8000-000000000194", users[0], session.hosted_session_id, id, old),
    db
      .prepare(
        "INSERT INTO transcript_entries (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, failure_reason) VALUES (?, ?, ?, ?, 'failed', ?, 'HostedInferenceFailed')"
      )
      .bind(
        "10000000-0000-4000-8000-000000000195",
        users[0],
        session.hosted_session_id,
        id,
        recent
      ),
    db
      .prepare(
        "UPDATE hosted_turns SET status = 'failed', terminal_at_ms = ?, failure_reason = 'HostedInferenceFailed' WHERE id = ?"
      )
      .bind(recent, id),
  ]);
  await sweepHostedTurns(db, now());
  expect(
    (await db.prepare("SELECT kind FROM transcript_entries WHERE turn_id = ?").bind(id).all())
      .results
  ).toHaveLength(2);
  await expect(
    db
      .prepare("DELETE FROM transcript_entries WHERE id = ?")
      .bind("10000000-0000-4000-8000-000000000194")
      .run()
  ).rejects.toThrow();
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
    STATEMENT_STAGING_BUCKET: undefined,
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
  const coordinator = new UserTransactionCoordinator(
    { id: { name: users[0] }, storage: { setAlarm: (): Promise<void> => Promise.resolve() } },
    environment
  );
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
