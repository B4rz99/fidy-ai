import {
  HostedAgentSessionId,
  TranscriptText,
  TranscriptTurnId,
} from "../../src/core/agent/contract";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/contract";
import { RecurringPlanId } from "../../src/core/recurring-plans/contract";
import { HostedTurnProposal } from "../../src/shell/agent/contract";
import {
  type HostedInferenceService,
  approvedWorkersAiModel,
} from "../../src/shell/hosted-inference/contract";
import { executeConsentWithdrawal } from "../consent/operations";
import { describeRecurringLifecycle } from "../recurring-plans/operations";
import { AgentUnavailable } from "./contract";
import { readBrowserConfirmation } from "./internal/hosted-browser-confirmation";
import { readAdmittedHostedConsent } from "./operations";
import { makeAgentRetention, makeAgentService } from "./runtime";

import { Cause, Clock, DateTime, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";

import {
  HostedDeliveryCorrelationToken,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import { newId } from "../secret-material/operations";
import { UserTransactionCoordinator } from "../transactions/runtime";
import { expireWhatsAppEvidence, findWhatsAppReplay } from "../whatsapp/operations";
import {
  VisibleReply,
  acknowledgeVisibleReply,
  closedContinuityFixture,
  completeHostedTurn,
  continuityCorruptions,
  coordinatorFor,
  encodeJson,
  gateCompactionBatch,
  grants,
  inference,
  installLifecycleAuditTriggers,
  makeAbortController,
  now,
  promiseGate,
  reply,
  retained,
  seedHistoryTransaction,
  seedRecurringReview,
  sessions,
  setup,
  subject,
  users,
  waitForInterrupted,
} from "./hosted-turn.test-fixture";
import {
  type HostedDelivery,
  browserHostedDelivery,
  completeHostedTurn as completeHostedTurnWithAlarm,
  readHostedProgress,
} from "./internal/hosted-turn";
import {
  admitHostedTurn,
  commitHostedCompaction,
  deliveryAcknowledgmentWindowMs,
  finishHostedTurn,
  hostedTranscriptRetentionMs,
  readHostedContinuity,
  readHostedSnapshot,
  recoverHostedTurn,
  selectHostedSession,
} from "./internal/turn-store";

it("replaces only a terminal prefix and preserves exact Failed evidence when a stale attempt loses", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const model = yield* Effect.tryPromise(() => inference(() => Promise.resolve(reply())));
      const awaited12 = yield* Effect.tryPromise(() => subject(0));
      const first = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited12,
          text: TranscriptText.make("Exact User words"),
          inference: model,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: first }));
      const awaited13 = yield* Effect.tryPromise(() => subject(0));
      const awaited14 = yield* Effect.tryPromise(() => inference(() => Promise.resolve(reply(""))));
      const failed = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited13,
          text: TranscriptText.make("Failed User words"),
          inference: awaited14,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      expect(failed.status).toBe(503);
      const session = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT id FROM hosted_agent_sessions WHERE user_id = ?")
          .bind(users[0])
          .first<{ id: string }>()
      );
      if (session === null) throw Error("missing session");
      const credential = yield* Effect.tryPromise(() => subject(0));
      const initial = yield* readHostedContinuity({
        db,
        subject: credential,
        sessionId: yield* Schema.decodeEffect(HostedAgentSessionId)(session.id),
        now: now(),
        admittedWhatsAppTurn: Option.none(),
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
        sessionId: yield* Schema.decodeEffect(HostedAgentSessionId)(session.id),
        continuity: initial,
        throughSequence: cursor.value,
        signal: makeAbortController().signal,
      };
      const aborted = makeAbortController();
      aborted.abort();
      expect(
        yield* commitHostedCompaction({ ...input, signal: aborted.signal, text: "Interrupted" })
      ).toBe(false);
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toHaveLength(4);
      const firstEntry = initial.transcript[0];
      if (firstEntry === undefined) throw Error("missing first entry");
      expect(
        yield* commitHostedCompaction({
          ...input,
          throughSequence: Number(firstEntry.sequence),
          text: "Partial",
        })
      ).toBe(false);
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toHaveLength(4);
      expect(yield* commitHostedCompaction({ ...input, text: "Fiel" })).toBe(true);
      expect(yield* commitHostedCompaction({ ...input, text: "Stale" })).toBe(false);
      const after = yield* readHostedContinuity({
        db,
        subject: credential,
        sessionId: input.sessionId,
        now: now(),
        admittedWhatsAppTurn: Option.none(),
      });
      expect(after.transcript).toHaveLength(0);
      expect(Option.map(after.compactedConversation, ({ text }) => text)).toEqual(
        Option.some("Fiel")
      );
      const next = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: credential,
          text: TranscriptText.make("Next"),
          inference: model,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: next }));
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toMatchObject([
        { kind: "user", text: "Next" },
        { kind: "assistant", text: "Listo" },
      ]);
    })
  ));

it("uses a bounded replacement in the next WorkingContext while retaining newer exact Turns", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const firstModel = yield* Effect.tryPromise(() =>
        inference(() => Promise.resolve(reply("Primera")))
      );
      const awaited15 = yield* Effect.tryPromise(() => subject(0));
      const first = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited15,
          text: TranscriptText.make("Uno"),
          inference: firstModel,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: first }));
      let calls = 0;
      const compacting = yield* Effect.tryPromise(() =>
        inference(() =>
          Promise.resolve(
            reply(++calls === 1 ? '{"compactedConversation":"Continuidad fiel"}' : "Segunda")
          )
        )
      );
      const model: HostedInferenceService = {
        ...compacting,
        countTranscript: () => Effect.succeed(100_001),
      };
      const awaited16 = yield* Effect.tryPromise(() => subject(0));
      const second = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited16,
          text: TranscriptText.make("Dos"),
          inference: model,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: second }));
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toMatchObject([
        { kind: "user", text: "Dos" },
        { kind: "assistant", text: "Segunda" },
      ]);
      const nextRequests: Array<unknown> = [];
      const nextModel = yield* Effect.tryPromise(() =>
        inference((request) => {
          nextRequests.push(request);
          return Promise.resolve(reply("Tercera"));
        })
      );
      const awaited17 = yield* Effect.tryPromise(() => subject(0));
      const third = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited17,
          text: TranscriptText.make("Tres"),
          inference: nextModel,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: third }));
      const context = encodeJson(nextRequests);
      expect(context).toContain("Continuidad fiel");
      expect(context).toContain("Dos");
      expect(context).not.toContain("Uno");
    })
  ));

it("rejects malformed Compaction output without removing exact evidence or prior continuity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const awaited18 = yield* Effect.tryPromise(() => subject(0));
      const awaited19 = yield* Effect.tryPromise(() => inference(() => Promise.resolve(reply())));
      const first = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited18,
          text: TranscriptText.make("First exact"),
          inference: awaited19,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: first }));
      const session = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT id FROM hosted_agent_sessions WHERE user_id = ?")
          .bind(users[0])
          .first<{ id: string }>()
      );
      if (session === null) throw Error("missing session");
      const credential = yield* Effect.tryPromise(() => subject(0));
      const sessionId = yield* Schema.decodeEffect(HostedAgentSessionId)(session.id);
      const firstEvidence = yield* readHostedContinuity({
        db,
        subject: credential,
        sessionId,
        now: now(),
        admittedWhatsAppTurn: Option.none(),
      });
      const firstCursor = firstEvidence.terminalThroughSequence;
      if (Option.isNone(firstCursor)) throw Error("missing prefix");
      expect(
        yield* commitHostedCompaction({
          db,
          subject: credential,
          sessionId,
          continuity: firstEvidence,
          throughSequence: firstCursor.value,
          text: "Prior continuity",
          signal: makeAbortController().signal,
        })
      ).toBe(true);
      const awaited20 = yield* Effect.tryPromise(() =>
        inference(() => Promise.resolve(reply("Second answer")))
      );
      const second = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: credential,
          text: TranscriptText.make("Second exact"),
          inference: awaited20,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: second }));
      let calls = 0;
      const provider = yield* Effect.tryPromise(() =>
        inference(() =>
          Promise.resolve(reply(++calls === 1 ? '{"compactedConversation":""}' : "Third answer"))
        )
      );
      const model: HostedInferenceService = {
        ...provider,
        countTranscript: () => Effect.succeed(100_001),
      };
      const third = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: credential,
          text: TranscriptText.make("Third exact"),
          inference: model,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      expect(
        yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: third }))
      ).toBe("Third answer");
      const after = yield* readHostedContinuity({
        db,
        subject: credential,
        sessionId,
        now: now(),
        admittedWhatsAppTurn: Option.none(),
      });
      expect(Option.map(after.compactedConversation, ({ text }) => text)).toEqual(
        Option.some("Prior continuity")
      );
      expect(after.transcript.map(({ entry }) => entry._tag)).toEqual([
        "UserTranscriptEntry",
        "AssistantTranscriptEntry",
        "UserTranscriptEntry",
        "AssistantTranscriptEntry",
      ]);
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toMatchObject([
        { kind: "user", text: "Second exact" },
        { kind: "assistant", text: "Second answer" },
        { kind: "user", text: "Third exact" },
        { kind: "assistant", text: "Third answer" },
      ]);
    })
  ));

it("does not replace continuity when Consent is revoked during Compaction generation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const awaited21 = yield* Effect.tryPromise(() => subject(0));
      const awaited22 = yield* Effect.tryPromise(() => inference(() => Promise.resolve(reply())));
      const first = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited21,
          text: TranscriptText.make("Private exact words"),
          inference: awaited22,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: first }));
      const before = (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results;
      const revokeDuringCompaction = (): Promise<Response> =>
        db
          .prepare(`INSERT INTO consent_user_revocations
    (id, user_id, grant_record_id, session_id, occurred_at_ms) VALUES (?, ?, ?, ?, ?)`)
          .bind(newId(), users[0], grants[0], sessions[0], now())
          .run()
          .then(() => reply('{"compactedConversation":"Forbidden"}'));
      const provider = yield* Effect.tryPromise(() => inference(revokeDuringCompaction));
      const model: HostedInferenceService = {
        ...provider,
        countTranscript: () => Effect.succeed(100_001),
      };
      const awaited23 = yield* Effect.tryPromise(() => subject(0));
      const refused = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited23,
          text: TranscriptText.make("Denied"),
          inference: model,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect((yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results).toEqual(
        before
      );
      const compacted = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT text FROM hosted_compacted_conversations WHERE user_id = ?")
          .bind(users[0])
          .all()
      );
      expect(compacted.results).toHaveLength(0);
    })
  ));

it("charges aborted pre-admission Compaction attempts against one User's daily capacity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const awaited24 = yield* Effect.tryPromise(() => subject(0));
      const awaited25 = yield* Effect.tryPromise(() => inference(() => Promise.resolve(reply())));
      const first = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited24,
          text: TranscriptText.make("Retain me"),
          inference: awaited25,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: first }));
      let providerCalls = 0;
      for (let attempt = 0; attempt < 4; attempt++) {
        const controller = makeAbortController();
        const abortedAttempt = attempt < 3;
        const provider = yield* Effect.tryPromise(() =>
          inference(() => {
            providerCalls++;
            if (abortedAttempt) controller.abort();
            return Promise.resolve(
              reply(abortedAttempt ? '{"compactedConversation":"Unused"}' : "Available")
            );
          })
        );
        const model: HostedInferenceService = {
          ...provider,
          countTranscript: () => Effect.succeed(100_001),
        };
        const awaited26 = yield* Effect.tryPromise(() => subject(0));
        const result = yield* Effect.tryPromise(() =>
          completeHostedTurn({
            db,
            subject: awaited26,
            text: TranscriptText.make(`Attempt ${attempt}`),
            inference: model,
            deliver: browserHostedDelivery,
            signal: controller.signal,
          })
        );
        if (abortedAttempt) {
          expect(result.status).toBe(503);
        } else {
          expect(
            yield* Effect.tryPromise(() =>
              acknowledgeVisibleReply({ db, index: 0, response: result })
            )
          ).toBe("Available");
        }
      }
      expect(providerCalls).toBe(4);
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toMatchObject([
        { kind: "user", text: "Retain me" },
        { kind: "assistant", text: "Listo" },
        { kind: "user", text: "Attempt 3" },
        { kind: "assistant", text: "Available" },
      ]);
      const attempts = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT used FROM hosted_compaction_attempts WHERE user_id = ?")
          .bind(users[0])
          .first<{ used: number }>()
      );
      expect(attempts?.used).toBe(3);
    })
  ));

it("compacts a long session of short Turns before its exact-entry capacity is reached", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO trial_periods VALUES (?,?,?)")
          .bind(users[0], now() - 1_000, now() - 1_000 + 604_800_000)
          .run()
      );
      const awaited27 = yield* Effect.tryPromise(() => subject(0));
      const awaited28 = yield* Effect.tryPromise(() => inference(() => Promise.resolve(reply())));
      const first = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited27,
          text: TranscriptText.make("Start"),
          inference: awaited28,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: first }));
      const session = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT id FROM hosted_agent_sessions WHERE user_id = ?")
          .bind(users[0])
          .first<{ id: string }>()
      );
      if (session === null) throw Error("missing session");
      yield* Effect.tryPromise(() =>
        db.batch(
          Array.from({ length: 39 }, () => {
            const turnId = newId();
            const timestamp = now();
            return [
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
            ];
          }).flat()
        )
      );
      let calls = 0;
      const provider = yield* Effect.tryPromise(() =>
        inference(() =>
          Promise.resolve(
            reply(++calls === 1 ? '{"compactedConversation":"Short history"}' : "Ready")
          )
        )
      );
      const awaited29 = yield* Effect.tryPromise(() => subject(0));
      const response = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited29,
          text: TranscriptText.make("Continue"),
          inference: provider,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      expect(
        yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response }))
      ).toBe("Ready");
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toMatchObject([
        { kind: "user", text: "Continue" },
        { kind: "assistant", text: "Ready" },
      ]);
    })
  ));

it("expires old CompactedConversation content without exposing it in a later WorkingContext", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const awaited30 = yield* Effect.tryPromise(() => subject(0));
      const awaited31 = yield* Effect.tryPromise(() => inference(() => Promise.resolve(reply())));
      const first = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited30,
          text: TranscriptText.make("Private old words"),
          inference: awaited31,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: first }));
      const session = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT id FROM hosted_agent_sessions WHERE user_id = ?")
          .bind(users[0])
          .first<{ id: string }>()
      );
      if (session === null) throw Error("missing session");
      const credential = yield* Effect.tryPromise(() => subject(0));
      const sessionId = yield* Schema.decodeEffect(HostedAgentSessionId)(session.id);
      const initial = yield* readHostedContinuity({
        db,
        subject: credential,
        sessionId,
        now: now(),
        admittedWhatsAppTurn: Option.none(),
      });
      const cursor = initial.terminalThroughSequence;
      if (Option.isNone(cursor)) throw Error("missing prefix");
      expect(
        yield* commitHostedCompaction({
          db,
          subject: credential,
          sessionId,
          continuity: initial,
          throughSequence: cursor.value,
          text: "Old private continuity",
          signal: makeAbortController().signal,
        })
      ).toBe(true);
      yield* Effect.tryPromise(() =>
        db
          .prepare(`UPDATE hosted_compacted_conversations SET updated_at_ms = ?
    WHERE user_id = ? AND hosted_session_id = ?`)
          .bind(now() - hostedTranscriptRetentionMs - 10_000, users[0], sessionId)
          .run()
      );
      const before = yield* readHostedContinuity({
        db,
        subject: credential,
        sessionId,
        now: now(),
        admittedWhatsAppTurn: Option.none(),
      });
      expect(Option.isNone(before.compactedConversation)).toBe(true);
      yield* makeAgentRetention({ db }).sweep(now());
      const after = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT text FROM hosted_compacted_conversations WHERE user_id = ?")
          .bind(users[0])
          .all()
      );
      expect(after.results).toHaveLength(0);
      const requests: Array<unknown> = [];
      const model = yield* Effect.tryPromise(() =>
        inference((request) => {
          requests.push(request);
          return Promise.resolve(reply());
        })
      );
      const next = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: credential,
          text: TranscriptText.make("New"),
          inference: model,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: next }));
      expect(encodeJson(requests)).not.toContain("Old private continuity");
    })
  ));

it("prepares current evidence only for its User and session, never mixing a second User's text", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const instant = DateTime.formatIso(DateTime.makeUnsafe(now()));
      const memories = [
        {
          id: "20000000-0000-4000-8000-0000000000a1",
          user_id: users[0],
          text: "retained-Memory-A",
          created_at: instant,
          updated_at: instant,
        },
        {
          id: "20000000-0000-4000-8000-0000000000a2",
          user_id: users[1],
          text: "retained-Memory-B",
          created_at: instant,
          updated_at: instant,
        },
      ];
      yield* Effect.tryPromise(() =>
        db.batch(
          memories.map((memory) =>
            db
              .prepare(
                "INSERT INTO memories (id, user_id, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
              )
              .bind(memory.id, memory.user_id, memory.text, memory.created_at, memory.updated_at)
          )
        )
      );
      const prompts: Array<unknown> = [];
      const model = yield* Effect.tryPromise(() =>
        inference((request) => {
          prompts.push(request);
          return Promise.resolve(reply());
        })
      );
      for (const index of [0, 1, 0]) {
        const credential = yield* Effect.tryPromise(() => subject(index));
        const output = yield* Effect.tryPromise(() =>
          completeHostedTurn({
            db,
            subject: credential,
            text: TranscriptText.make(index === 0 ? "private-A" : "private-B"),
            inference: model,
            deliver: browserHostedDelivery,
            signal: makeAbortController().signal,
          })
        );
        yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index, response: output }));
      }
      const serialized = prompts.map((prompt) => encodeJson(prompt));
      expect(serialized[2]).toContain("private-A");
      expect(serialized[2]).not.toContain("private-B");
      expect(serialized[1]).not.toContain("private-A");
      for (const index of [0, 2]) {
        expect(serialized[index]).toContain("retained-Memory-A");
        expect(serialized[index]).not.toContain("retained-Memory-B");
      }
      expect(serialized[1]).toContain("retained-Memory-B");
      expect(serialized[1]).not.toContain("retained-Memory-A");
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT id, user_id, text, created_at, updated_at FROM memories ORDER BY user_id, id"
            )
            .all()
        )).results
      ).toEqual(memories);
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toHaveLength(4);
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[1] }))).results
      ).toHaveLength(2);
    })
  ));

it("never retains invalid output as an assistant reply and records delivery failure without text", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const invalidModel = yield* Effect.tryPromise(() =>
        inference(() => Promise.resolve(reply("")))
      );
      const awaited32 = yield* Effect.tryPromise(() => subject(0));
      const invalid = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited32,
          text: TranscriptText.make("Invalid"),
          inference: invalidModel,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      expect(invalid.status).toBe(503);
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toMatchObject([
        { status: "failed", kind: "user", text: "Invalid" },
        { status: "failed", kind: "failed", text: null, marker: "HostedInferenceFailed" },
      ]);
      const model = yield* Effect.tryPromise(() =>
        inference(() => Promise.resolve(reply("Secret answer")))
      );
      const notDelivered: HostedDelivery = () => Promise.reject(new Error("channel closed"));
      const awaited33 = yield* Effect.tryPromise(() => subject(0));
      const failure = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited33,
          text: TranscriptText.make("Delivery"),
          inference: model,
          deliver: notDelivered,
          signal: makeAbortController().signal,
        })
      );
      expect(failure.status).toBe(503);
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toMatchObject([
        {},
        {},
        { status: "failed", kind: "user", text: "Delivery" },
        { status: "failed", kind: "failed", text: null, marker: "DeliveryFailed" },
      ]);
    })
  ));

it("finishes an already-running Turn after authenticated withdrawal but refuses the next Turn", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const caller = yield* Effect.tryPromise(() => subject(0));
      const runWithdrawal = Effect.runPromiseWith(yield* Effect.context<never>());
      const run = vi.fn(() =>
        runWithdrawal(
          Effect.gen(function* () {
            const withdrawal = yield* executeConsentWithdrawal({
              db,
              userId: caller.userId,
              candidate: {
                userId: caller.userId,
                sessionId: caller.id,
                digest: Array.from(caller.digest),
                deadlineMilliseconds: (yield* Clock.currentTimeMillis) + 5000,
              },
              signal: makeAbortController().signal,
            });
            expect(withdrawal.status).toBe(200);
            expect(yield* Effect.tryPromise(withdrawal.json.bind(withdrawal))).toMatchObject({
              status: "Revoked",
            });
            return reply("Finish the running request");
          })
        )
      );
      const model = yield* Effect.tryPromise(() => inference(run));
      const finished = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: caller,
          text: TranscriptText.make("Already running"),
          inference: model,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      expect(
        yield* Effect.tryPromise(() =>
          acknowledgeVisibleReply({ db, index: 0, response: finished })
        )
      ).toBe("Finish the running request");
      const before = (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results;
      expect(before).toMatchObject([
        { status: "completed", kind: "user" },
        { status: "completed", kind: "assistant" },
      ]);
      const refused = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: caller,
          text: TranscriptText.make("Waiting request"),
          inference: model,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      expect(refused.status).toBe(403);
      expect(run).toHaveBeenCalledTimes(1);
      expect((yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results).toEqual(
        before
      );
    })
  ));

it("recovers abandoned Pending once, then refuses new work after Consent withdrawal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const model = yield* Effect.tryPromise(() => inference(() => Promise.resolve(reply())));
      const awaited34 = yield* Effect.tryPromise(() => subject(0));
      const initial = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited34,
          text: TranscriptText.make("Before"),
          inference: model,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: initial }));
      const existing = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT id, hosted_session_id FROM hosted_turns WHERE user_id = ?")
          .bind(users[0])
          .first<{ id: string; hosted_session_id: string }>()
      );
      if (existing === null) throw Error("missing Turn");
      const pending = "10000000-0000-4000-8000-000000000190";
      const timestamp = now();
      yield* Effect.tryPromise(() =>
        db.batch([
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
        ])
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO hosted_delivery_proposals
    (turn_id, user_id, receipt_digest, proposed_at_ms, text) VALUES (?, ?, ?, ?, ?)`)
          .bind(pending, users[0], new Uint8Array(32), timestamp - 121_000, "Unacknowledged answer")
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO consent_user_revocations (id, user_id, grant_record_id, session_id, occurred_at_ms) VALUES (?, ?, ?, ?, ?)"
          )
          .bind("10000000-0000-4000-8000-000000000192", users[0], grants[0], sessions[0], timestamp)
          .run()
      );
      const awaited35 = yield* Effect.tryPromise(() => subject(0));
      const blocked = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited35,
          text: TranscriptText.make("After"),
          inference: model,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      expect(blocked.status).toBe(403);
      const rows = (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results;
      expect(rows).toMatchObject([
        { status: "completed", kind: "user" },
        { status: "completed", kind: "assistant" },
        { status: "interrupted", kind: "user", text: "Abandoned" },
        { status: "interrupted", kind: "interrupted", text: null },
      ]);
      expect(rows).toHaveLength(4);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT turn_id FROM hosted_delivery_proposals WHERE user_id = ?")
            .bind(users[0])
            .all()
        )).results
      ).toHaveLength(0);
    })
  ));

it("recovers an abandoned staged reply by durable alarm without another User request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const awaited36 = yield* Effect.tryPromise(() => subject(0));
      const awaited37 = yield* Effect.tryPromise(() => inference(() => Promise.resolve(reply())));
      const first = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited36,
          text: TranscriptText.make("First"),
          inference: awaited37,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: first }));
      const existing = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT hosted_session_id FROM hosted_turns WHERE user_id = ?")
          .bind(users[0])
          .first<{ hosted_session_id: string }>()
      );
      if (existing === null) throw Error("missing session");
      const id = "10000000-0000-4000-8000-000000000195";
      const timestamp = now();
      yield* Effect.tryPromise(() =>
        db.batch([
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
        ])
      );
      const scheduled: Array<number | Date> = [];
      const coordinator = new UserTransactionCoordinator(
        {
          id: { name: users[0] },
          storage: {
            getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> => Promise.resolve(null),
            deleteAlarm: (): Promise<void> => Promise.resolve(),
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
      yield* Effect.tryPromise(() => coordinator.alarm());
      expect(scheduled).toHaveLength(1);
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results.slice(-2)
      ).toMatchObject([
        { kind: "user", status: "interrupted" },
        { kind: "interrupted", status: "interrupted" },
      ]);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT turn_id FROM hosted_delivery_proposals WHERE turn_id = ?")
            .bind(id)
            .all()
        )).results
      ).toHaveLength(0);
      yield* Effect.tryPromise(() => coordinator.alarm());
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toHaveLength(4);
      const oldest = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT MIN(terminal_at_ms) AS due FROM hosted_turns WHERE user_id = ?")
          .bind(users[0])
          .first<{ due: number }>()
      );
      if (oldest === null) throw Error("missing terminal Turn");
      expect(Number(scheduled.at(-1))).toBe(oldest.due + hostedTranscriptRetentionMs + 1);
    })
  ));

it("expires only one User's eligible channel evidence while preserving pending, recent and foreign replay", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const timestamp = now();
      const cutoff = timestamp - hostedTranscriptRetentionMs;
      const cases = [
        { userId: UserId.make(users[0]), terminalAt: cutoff - 1, pending: false, expires: true },
        { userId: UserId.make(users[1]), terminalAt: cutoff - 1, pending: false, expires: false },
        { userId: UserId.make(users[0]), terminalAt: cutoff, pending: false, expires: false },
        { userId: UserId.make(users[0]), terminalAt: cutoff - 1, pending: true, expires: false },
      ].map((entry) => ({
        ...entry,
        turnId: TranscriptTurnId.make(newId()),
        sessionId: HostedAgentSessionId.make(newId()),
        token: HostedDeliveryCorrelationToken.make(newId()),
      }));
      const evidenceFor = (turnId: TranscriptTurnId): Promise<ReadonlyArray<unknown>> =>
        db
          .batch([
            db.prepare("SELECT * FROM hosted_whatsapp_inbound WHERE turn_id = ?").bind(turnId),
            db.prepare("SELECT * FROM hosted_whatsapp_delivery WHERE turn_id = ?").bind(turnId),
            db
              .prepare(`SELECT e.* FROM hosted_whatsapp_delivery_events AS e
            JOIN hosted_whatsapp_delivery AS d ON d.correlation_token = e.correlation_token
            WHERE d.turn_id = ?`)
              .bind(turnId),
          ])
          .then((batches) => batches.map(({ results }) => results));
      for (const entry of cases) {
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(`INSERT INTO hosted_agent_sessions
            (id, user_id, consent_basis_json, started_at_ms, status) VALUES (?, ?, '{}', ?, 'active')`)
              .bind(entry.sessionId, entry.userId, entry.terminalAt - 1),
            db
              .prepare(`INSERT INTO hosted_turns
            (id, user_id, hosted_session_id, started_at_ms, status) VALUES (?, ?, ?, ?, 'pending')`)
              .bind(entry.turnId, entry.userId, entry.sessionId, entry.terminalAt - 1),
            db
              .prepare(`INSERT INTO transcript_entries
            (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text)
            VALUES (?, ?, ?, ?, 'user', ?, 'Retained exact User text')`)
              .bind(newId(), entry.userId, entry.sessionId, entry.turnId, entry.terminalAt - 1),
            db
              .prepare(`INSERT INTO hosted_whatsapp_inbound
            (turn_id, user_id, portfolio_id, bsuid, message_id, business_phone_number_id, occurred_at_ms, received_at_ms, sandbox_phone)
            VALUES (?, ?, 'portfolio-1', 'CO.13491208655302741918', ?, '123456789', ?, ?, '+573001234567')`)
              .bind(
                entry.turnId,
                entry.userId,
                `wamid.retention.${entry.turnId}`,
                entry.terminalAt - 1,
                entry.terminalAt - 1
              ),
            db
              .prepare(`INSERT INTO hosted_whatsapp_delivery
            (turn_id, user_id, text, correlation_token, business_phone_number_id, proposed_at_ms,
              state, provider_message_id, delivered_at_ms, send_started_at_ms)
            VALUES (?, ?, 'Retained exact reply', ?, '123456789', ?, 'delivered', ?, ?, ?)`)
              .bind(
                entry.turnId,
                entry.userId,
                entry.token,
                entry.terminalAt - 1,
                `wamid.answer.${entry.turnId}`,
                entry.terminalAt,
                entry.terminalAt - 1
              ),
            db
              .prepare(`INSERT INTO hosted_whatsapp_delivery_events
            (correlation_token, provider_message_id, status, occurred_at_ms, received_at_ms)
            VALUES (?, ?, 'delivered', ?, ?)`)
              .bind(
                entry.token,
                `wamid.answer.${entry.turnId}`,
                entry.terminalAt,
                entry.terminalAt
              ),
          ])
        );
        if (!entry.pending) {
          yield* Effect.tryPromise(() =>
            db.batch([
              db
                .prepare(`INSERT INTO transcript_entries
              (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text)
              VALUES (?, ?, ?, ?, 'assistant', ?, 'Retained exact reply')`)
                .bind(newId(), entry.userId, entry.sessionId, entry.turnId, entry.terminalAt),
              db
                .prepare(
                  "UPDATE hosted_turns SET status = 'completed', terminal_at_ms = ? WHERE id = ?"
                )
                .bind(entry.terminalAt, entry.turnId),
            ])
          );
        }
      }
      const before = yield* Effect.tryPromise(() =>
        Promise.all(cases.map(({ turnId }) => evidenceFor(turnId)))
      );
      yield* expireWhatsAppEvidence({ db, userId: UserId.make(users[0]), now: timestamp });
      for (const [index, entry] of cases.entries()) {
        const retained = yield* Effect.tryPromise(() => evidenceFor(entry.turnId));
        expect(retained).toEqual(entry.expires ? [[], [], []] : before[index]);
        expect(
          yield* findWhatsAppReplay({
            db,
            userId: entry.userId,
            portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-1"),
            bsuid: WhatsAppBusinessScopedUserId.make("CO.13491208655302741918"),
            messageId: WhatsAppProviderMessageId.make(`wamid.retention.${entry.turnId}`),
            text: TranscriptText.make("Retained exact User text"),
          })
        ).toBe(entry.expires ? "fresh" : "replay");
      }
    })
  ));

it("allows only the timed User-scoped retention sweep to remove old terminal evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const awaited38 = yield* Effect.tryPromise(() => subject(0));
      const awaited39 = yield* Effect.tryPromise(() => inference(() => Promise.resolve(reply())));
      const first = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited38,
          text: TranscriptText.make("Recent"),
          inference: awaited39,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: first }));
      const session = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT hosted_session_id FROM hosted_turns WHERE user_id = ?")
          .bind(users[0])
          .first<{ hosted_session_id: string }>()
      );
      if (session === null) throw Error("missing session");
      const id = "10000000-0000-4000-8000-000000000197";
      const old = now() - hostedTranscriptRetentionMs - 10_000;
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO hosted_turns (id, user_id, hosted_session_id, status, started_at_ms) VALUES (?, ?, ?, 'pending', ?)"
            )
            .bind(id, users[0], session.hosted_session_id, old),
          db
            .prepare(
              "INSERT INTO transcript_entries (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text) VALUES (?, ?, ?, ?, 'user', ?, 'Old private text')"
            )
            .bind(
              "10000000-0000-4000-8000-000000000198",
              users[0],
              session.hosted_session_id,
              id,
              old
            ),
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
        ])
      );
      yield* Effect.tryPromise(() =>
        expect(
          db.prepare("DELETE FROM transcript_entries WHERE user_id = ?").bind(users[0]).run()
        ).rejects.toThrow()
      );
      yield* makeAgentRetention({ db }).sweep(now());
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT kind FROM transcript_entries WHERE turn_id = ?").bind(id).all()
        )).results
      ).toHaveLength(0);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT kind FROM transcript_entries WHERE user_id = ?").bind(users[0]).all()
        )).results
      ).toHaveLength(2);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT status FROM hosted_turns WHERE id = ?").bind(id).first()
        )
      ).toEqual({ status: "failed" });
    })
  ));

it("retains the complete Turn until thirty days after its terminal marker", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const awaited40 = yield* Effect.tryPromise(() => subject(0));
      const awaited41 = yield* Effect.tryPromise(() => inference(() => Promise.resolve(reply())));
      const first = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited40,
          text: TranscriptText.make("Current"),
          inference: awaited41,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: first }));
      const session = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT hosted_session_id FROM hosted_turns WHERE user_id = ?")
          .bind(users[0])
          .first<{ hosted_session_id: string }>()
      );
      if (session === null) throw Error("missing session");
      const id = "10000000-0000-4000-8000-000000000193";
      const old = now() - hostedTranscriptRetentionMs - 10_000;
      const recent = now();
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO hosted_turns (id, user_id, hosted_session_id, status, started_at_ms) VALUES (?, ?, ?, 'pending', ?)"
            )
            .bind(id, users[0], session.hosted_session_id, old),
          db
            .prepare(
              "INSERT INTO transcript_entries (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text) VALUES (?, ?, ?, ?, 'user', ?, 'Old User content')"
            )
            .bind(
              "10000000-0000-4000-8000-000000000194",
              users[0],
              session.hosted_session_id,
              id,
              old
            ),
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
        ])
      );
      yield* makeAgentRetention({ db }).sweep(now());
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT kind FROM transcript_entries WHERE turn_id = ?").bind(id).all()
        )).results
      ).toHaveLength(2);
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare("DELETE FROM transcript_entries WHERE id = ?")
            .bind("10000000-0000-4000-8000-000000000194")
            .run()
        ).rejects.toThrow()
      );
    })
  ));

it("serializes concurrent requests at the per-User coordinator and admits two distinct Turns", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const entered = promiseGate();
      const wait = promiseGate();
      let count = 0;
      const environment: ConstructorParameters<typeof UserTransactionCoordinator>[1] = {
        DB: db,
        STATEMENT_STAGING_BUCKET: undefined,
        HOSTED_AI_MODEL: approvedWorkersAiModel,
        AI: {
          run: () => {
            count++;
            if (count === 1) {
              entered.release();
              return wait.promise.then(() => reply("First"));
            }
            return Promise.resolve(reply("Second"));
          },
        },
      };
      const coordinator = new UserTransactionCoordinator(
        {
          id: { name: users[0] },
          storage: {
            getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> => Promise.resolve(null),
            deleteAlarm: (): Promise<void> => Promise.resolve(),
            setAlarm: (): Promise<void> => Promise.resolve(),
          },
        },
        environment
      );
      const credentials = yield* Effect.tryPromise(() => subject(0));
      const send = (text: string): Promise<Response> =>
        coordinator.fetch(
          new Request("https://coordinator.internal/hosted-turn", {
            method: "POST",
            body: encodeJson({
              userId: credentials.userId,
              sessionId: credentials.id,
              digest: Array.from(credentials.digest),
              text,
            }),
          })
        );
      const first = send("One");
      yield* Effect.tryPromise(() => entered.promise);
      const second = send("Two");
      expect(count).toBe(1);
      wait.release();
      const firstReply = yield* Effect.tryPromise(() => first);
      const blocked = yield* Effect.tryPromise(() => second);
      expect(blocked.status).toBe(409);
      expect(count).toBe(1);
      const visible = yield* Schema.decodeUnknownEffect(VisibleReply)(
        yield* Effect.tryPromise(() => firstReply.json())
      );
      const acknowledged = yield* Effect.tryPromise(() =>
        coordinator.fetch(
          new Request("https://coordinator.internal/hosted-turn/receipt", {
            method: "POST",
            body: encodeJson({
              userId: credentials.userId,
              sessionId: credentials.id,
              digest: Array.from(credentials.digest),
              turnId: visible.turnId,
              receipt: visible.receipt,
            }),
          })
        )
      );
      expect(acknowledged.status).toBe(200);
      const third = yield* Effect.tryPromise(() => send("Two"));
      expect(
        yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: third }))
      ).toBe("Second");
      expect(count).toBe(2);
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toMatchObject([
        { status: "completed", kind: "user", text: "One" },
        { status: "completed", kind: "assistant", text: "First" },
        { status: "completed", kind: "user", text: "Two" },
        { status: "completed", kind: "assistant", text: "Second" },
      ]);
    })
  ));

it.each([
  { standing: "Free", limit: 10, trial: false },
  { standing: "Trial", limit: 50, trial: true },
])(
  "checks the $standing daily allowance before provider preparation or new evidence",
  ({ limit, trial }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        if (trial) {
          yield* Effect.tryPromise(() =>
            db
              .prepare("INSERT INTO trial_periods VALUES (?,?,?)")
              .bind(users[0], now() - 1_000, now() - 1_000 + 604_800_000)
              .run()
          );
        }
        let calls = 0;
        const model = yield* Effect.tryPromise(() =>
          inference(() => {
            calls++;
            return Promise.resolve(reply());
          })
        );
        const awaited42 = yield* Effect.tryPromise(() => subject(0));
        const first = yield* Effect.tryPromise(() =>
          completeHostedTurn({
            db,
            subject: awaited42,
            text: TranscriptText.make("Initial"),
            inference: model,
            deliver: browserHostedDelivery,
            signal: makeAbortController().signal,
          })
        );
        yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: first }));
        const session = yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT hosted_session_id FROM hosted_turns WHERE user_id = ?")
            .bind(users[0])
            .first<{ hosted_session_id: string }>()
        );
        if (session === null) throw Error("missing Hosted Agent Session");
        const timestamp = now();
        const terminalTurnStatements = (index: number): D1PreparedStatement[] => {
          const turn = newId();
          return [
            db
              .prepare(
                "INSERT INTO hosted_turns (id, user_id, hosted_session_id, status, started_at_ms) VALUES (?, ?, ?, 'pending', ?)"
              )
              .bind(turn, users[0], session.hosted_session_id, timestamp),
            db
              .prepare(
                "INSERT INTO transcript_entries (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text) VALUES (?, ?, ?, ?, 'user', ?, ?)"
              )
              .bind(
                newId(),
                users[0],
                session.hosted_session_id,
                turn,
                timestamp,
                `Budget ${index}`
              ),
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
          ];
        };
        yield* Effect.tryPromise(() =>
          db.batch(
            Array.from({ length: limit - 2 }, (_, index) => index).flatMap(terminalTurnStatements)
          )
        );
        const awaited43 = yield* Effect.tryPromise(() => subject(0));
        const last = yield* Effect.tryPromise(() =>
          completeHostedTurn({
            db,
            subject: awaited43,
            text: TranscriptText.make("Last allowed"),
            inference: model,
            deliver: browserHostedDelivery,
            signal: makeAbortController().signal,
          })
        );
        yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: last }));
        const callsBeforeRefusal = calls;
        const entriesBeforeRefusal = yield* Effect.tryPromise(() =>
          retained({ db, user: users[0] })
        );
        const overQuota = yield* Effect.tryPromise(() =>
          completeHostedTurn({
            db,
            subject: awaited43,
            text: TranscriptText.make("Over quota"),
            inference: model,
            deliver: browserHostedDelivery,
            signal: makeAbortController().signal,
          })
        );
        expect(overQuota.status).toBe(429);
        expect(calls).toBe(callsBeforeRefusal);
        const exhausted = yield* readHostedSnapshot({ db, subject: awaited43, now: now() });
        if (Option.isNone(exhausted)) return yield* Effect.die("missing fixture authority");
        const bypass = yield* admitHostedTurn({
          db,
          channel: { _tag: "Browser", subject: awaited43 },
          selection: selectHostedSession({
            snapshot: exhausted.value,
            userId: UserId.make(users[0]),
            now: now(),
          }),
          text: TranscriptText.make("Bypass preflight"),
          now: now(),
          id: TranscriptTurnId.make(newId()),
        });
        expect(bypass).toEqual(Option.none());

        expect((yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results).toEqual(
          entriesBeforeRefusal.results
        );
      })
    )
);

it("refuses stale credentials and cross-User proofs before retaining or sending context", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      let sends = 0;
      const model = yield* Effect.tryPromise(() =>
        inference(() => {
          sends++;
          return Promise.resolve(reply());
        })
      );
      const stolen = { ...(yield* Effect.tryPromise(() => subject(0))), userId: users[1] };
      const mismatch = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: stolen,
          text: TranscriptText.make("Untrusted"),
          inference: model,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      expect(mismatch.status).toBe(401);
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE web_sessions SET idle_expires_at_ms = ? WHERE id = ?")
          .bind(now() - 1, sessions[0])
          .run()
      );
      const awaited44 = yield* Effect.tryPromise(() => subject(0));
      const stale = yield* Effect.tryPromise(() =>
        completeHostedTurn({
          db,
          subject: awaited44,
          text: TranscriptText.make("Expired"),
          inference: model,
          deliver: browserHostedDelivery,
          signal: makeAbortController().signal,
        })
      );
      expect(stale.status).toBe(401);
      expect(sends).toBe(0);
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toHaveLength(0);
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[1] }))).results
      ).toHaveLength(0);
    })
  ));

it("expires a proposed reply at its original deadline despite repeated authenticated progress polls", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const credential = yield* Effect.tryPromise(() => subject(0));
      const coordinator = new UserTransactionCoordinator(
        {
          id: { name: users[0] },
          storage: {
            getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> => Promise.resolve(null),
            deleteAlarm: (): Promise<void> => Promise.resolve(),
            setAlarm: (): Promise<void> => Promise.resolve(),
          },
        },
        {
          DB: db,
          HOSTED_AI_MODEL: approvedWorkersAiModel,
          AI: { run: (): Promise<Response> => Promise.resolve(reply("Sin acuse")) },
        }
      );
      const proposed = yield* Effect.tryPromise(() =>
        coordinator.fetch(
          new Request("https://coordinator.internal/hosted-turn", {
            method: "POST",
            body: encodeJson({
              userId: credential.userId,
              sessionId: credential.id,
              digest: Array.from(credential.digest),
              text: "Propón una respuesta",
            }),
          })
        )
      );
      expect(proposed.status).toBe(202);
      const visible = yield* Schema.decodeUnknownEffect(VisibleReply)(
        yield* Effect.tryPromise(() => proposed.json())
      );
      const original = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT proposed_at_ms FROM hosted_delivery_proposals WHERE turn_id = ?")
          .bind(visible.turnId)
          .first<{ proposed_at_ms: number }>()
      );
      if (original === null) throw Error("missing proposal");
      const clock = vi.spyOn(Date, "now");
      try {
        for (const elapsed of [1_000, 60_000, 119_999, 120_000]) {
          clock.mockReturnValue(original.proposed_at_ms + elapsed);
          const progress = yield* Effect.tryPromise(() =>
            coordinator.fetch(
              new Request("https://coordinator.internal/hosted-turn/progress", {
                method: "POST",
                body: encodeJson({
                  userId: credential.userId,
                  sessionId: credential.id,
                  digest: Array.from(credential.digest),
                  turnId: visible.turnId,
                }),
              })
            )
          );
          expect(progress.status).toBe(elapsed < 120_000 ? 202 : 503);
          if (elapsed < 120_000) {
            expect(
              (yield* Schema.decodeUnknownEffect(VisibleReply)(
                yield* Effect.tryPromise(() => progress.json())
              )).text
            ).toBe("Sin acuse");
            const saved = yield* Effect.tryPromise(() =>
              db
                .prepare("SELECT proposed_at_ms FROM hosted_delivery_proposals WHERE turn_id = ?")
                .bind(visible.turnId)
                .first<{ proposed_at_ms: number }>()
            );
            expect(saved?.proposed_at_ms).toBe(original.proposed_at_ms);
          }
        }
      } finally {
        clock.mockRestore();
      }
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toMatchObject([
        { status: "interrupted", kind: "user" },
        { status: "interrupted", kind: "interrupted", text: null },
      ]);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT turn_id FROM hosted_delivery_proposals WHERE turn_id = ?")
            .bind(visible.turnId)
            .all()
        )
      ).toMatchObject({ results: [] });
    })
  ));

it("interrupts in-flight work with only a metadata marker and recovers without provider output", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const controller = makeAbortController();
      let entered = false;
      const model = yield* Effect.tryPromise(() =>
        inference(() => {
          entered = true;
          controller.abort();
          return Promise.reject(new Error("aborted"));
        })
      );
      const work = completeHostedTurn({
        db,
        subject: yield* Effect.tryPromise(() => subject(0)),
        text: TranscriptText.make("Interrupted request"),
        inference: model,
        deliver: browserHostedDelivery,
        signal: controller.signal,
      });
      expect((yield* Effect.tryPromise(() => work)).status).toBe(503);
      expect(entered).toBe(true);
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toMatchObject([
        { status: "interrupted", kind: "user", text: "Interrupted request" },
        { status: "interrupted", kind: "interrupted", text: null, marker: null },
      ]);
    })
  ));

it("refuses another User's complete live proof at the Agent service before model work or retention", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const credentials = yield* Effect.tryPromise(() => subject(1));
      const model = vi.fn(() => Promise.resolve(reply("Never disclosed")));
      const service = makeAgentService({
        environment: { DB: db, HOSTED_AI_MODEL: approvedWorkersAiModel, AI: { run: model } },
        userId: UserId.make(users[0]),
        scheduleRecovery: () => Promise.resolve(),
      });
      const accepted = service.accept({
        request: new Request("https://coordinator.internal/hosted-turn", {
          method: "POST",
          body: encodeJson({
            userId: credentials.userId,
            sessionId: credentials.id,
            digest: Array.from(credentials.digest),
            text: "Retain this for the other User",
          }),
        }),
        preceding: Promise.resolve(),
      });
      if (Option.isNone(accepted)) return yield* Effect.die("missing hosted request");
      const response = yield* Effect.tryPromise(() => accepted.value.response);
      yield* Effect.tryPromise(() => accepted.value.settled);
      expect(response.status).toBe(503);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ status: "unavailable" });
      expect(model).not.toHaveBeenCalled();
      expect((yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results).toEqual(
        []
      );
      expect((yield* Effect.tryPromise(() => retained({ db, user: users[1] }))).results).toEqual(
        []
      );
    })
  ));

it("stops unavailable alarm retries when the hosted owner settles and preserves durable recovery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const credentials = yield* Effect.tryPromise(() => subject(0));
      const scheduling = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let alarmCalls = 0;
      let unavailable = true;
      let settled = false;
      const service = makeAgentService({
        environment: {
          DB: db,
          HOSTED_AI_MODEL: approvedWorkersAiModel,
          AI: { run: () => Promise.resolve(reply("Propuesta sin entregar")) },
        },
        userId: UserId.make(users[0]),
        scheduleRecovery: () => {
          alarmCalls += 1;
          if (alarmCalls === 2) {
            scheduling.resolve();
            return release.promise;
          }
          return alarmCalls > 2 && unavailable
            ? Promise.reject(new Error("private alarm failure"))
            : Promise.resolve();
        },
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const accepted = Option.getOrThrow(
        service.accept({
          request: new Request("https://coordinator.internal/hosted-turn", {
            method: "POST",
            body: encodeJson({
              userId: credentials.userId,
              sessionId: credentials.id,
              digest: Array.from(credentials.digest),
              text: "Hola",
            }),
          }),
          preceding: Promise.resolve(),
        })
      );
      const ownerSettled = accepted.settled.then(() => {
        settled = true;
      });
      try {
        yield* Effect.tryPromise(() => scheduling.promise);
        yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(25_001));
        const response = yield* Effect.tryPromise(() => accepted.response);
        expect(response.status).toBe(202);
        const progress = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ status: Schema.Literal("processing"), turnId: TranscriptTurnId })
        )(yield* Effect.tryPromise(() => response.json()));
        yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(135_001));
        yield* Effect.tryPromise(() => waitForInterrupted({ db, turnId: progress.turnId }));
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(alarmCalls).toBeGreaterThanOrEqual(3))
        );
        yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(1_001));
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(alarmCalls).toBeGreaterThanOrEqual(4))
        );
        expect(settled).toBe(false);
        release.resolve();
        yield* Effect.tryPromise(() => ownerSettled);
        const callsAtSettlement = alarmCalls;
        yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(5_001));
        expect(alarmCalls).toBe(callsAtSettlement);
        yield* Effect.tryPromise(() =>
          service.recover().then(
            () => assert.fail("unavailable durable alarm must reject"),
            (failure: unknown) => assert.deepStrictEqual(failure, new AgentUnavailable())
          )
        );
        unavailable = false;
        yield* Effect.tryPromise(() => service.recover());
        expect(
          (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
        ).toMatchObject([
          { status: "interrupted", kind: "user", text: "Hola" },
          { status: "interrupted", kind: "interrupted", text: null },
        ]);
        expect((yield* Effect.tryPromise(() => retained({ db, user: users[1] }))).results).toEqual(
          []
        );
      } finally {
        release.resolve();
        try {
          yield* Effect.tryPromise(() => ownerSettled);
        } finally {
          vi.useRealTimers();
        }
      }
    })
  ));

it("does not retry a recovery defect or release queued work before its hosted owner settles", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const credentials = yield* Effect.tryPromise(() => subject(0));
      const scheduling = Promise.withResolvers<void>();
      const releaseOwner = Promise.withResolvers<void>();
      const snapshotRead = Promise.withResolvers<void>();
      const releaseSnapshot = Promise.withResolvers<void>();
      const recoveryBatchFinished = Promise.withResolvers<void>();
      let observeRecovery = false;
      let snapshotReleased = false;
      let recoveryReads = 0;
      let alarmCalls = 0;
      let settled = false;
      const delayedDb = new Proxy(db, {
        get(target, key): unknown {
          if (key === "batch") {
            return (statements: D1PreparedStatement[]): Promise<D1Result[]> =>
              target.batch(statements).then((results) => {
                if (snapshotReleased) recoveryBatchFinished.resolve();
                return results;
              });
          }
          if (key === "prepare") {
            return (sql: string): D1PreparedStatement => {
              const prepared = target.prepare(sql);
              if (!observeRecovery || !sql.startsWith("SELECT id, started_at_ms,")) return prepared;
              recoveryReads += 1;
              const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
                new Proxy(statement, {
                  get(native, method): unknown {
                    if (method === "bind") {
                      return (...values: unknown[]): D1PreparedStatement =>
                        wrap(native.bind(...values));
                    }
                    if (method === "first" && recoveryReads === 1) {
                      return (): Promise<unknown> =>
                        native.first().then((row) => {
                          snapshotRead.resolve();
                          return releaseSnapshot.promise.then(() => row);
                        });
                    }
                    const value: unknown = Reflect.get(native, method, native);
                    return typeof value === "function" ? value.bind(native) : value;
                  },
                });
              return wrap(prepared);
            };
          }
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const service = makeAgentService({
        environment: {
          DB: delayedDb,
          HOSTED_AI_MODEL: approvedWorkersAiModel,
          AI: { run: () => Promise.resolve(reply("Propuesta sin entregar")) },
        },
        userId: UserId.make(users[0]),
        scheduleRecovery: () => {
          alarmCalls += 1;
          if (alarmCalls !== 2) return Promise.resolve();
          scheduling.resolve();
          return releaseOwner.promise;
        },
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const accepted = Option.getOrThrow(
        service.accept({
          request: new Request("https://coordinator.internal/hosted-turn", {
            method: "POST",
            body: encodeJson({
              userId: credentials.userId,
              sessionId: credentials.id,
              digest: Array.from(credentials.digest),
              text: "Hola",
            }),
          }),
          preceding: Promise.resolve(),
        })
      );
      const ownerSettled = accepted.settled.then(() => {
        settled = true;
      });
      try {
        yield* Effect.tryPromise(() => scheduling.promise);
        observeRecovery = true;
        yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(160_001));
        yield* Effect.tryPromise(() => snapshotRead.promise);
        yield* makeAgentRetention({ db }).sweep(now());
        snapshotReleased = true;
        releaseSnapshot.resolve();
        yield* Effect.tryPromise(() => recoveryBatchFinished.promise);
        yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(5_001));
        expect((yield* Effect.tryPromise(() => accepted.response)).status).toBe(202);
        expect({ recoveryReads, alarmCalls, settled }).toEqual({
          recoveryReads: 1,
          alarmCalls: 2,
          settled: false,
        });
        expect(
          (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
        ).toMatchObject([
          { status: "interrupted", kind: "user", text: "Hola" },
          { status: "interrupted", kind: "interrupted", text: null },
        ]);
        expect((yield* Effect.tryPromise(() => retained({ db, user: users[1] }))).results).toEqual(
          []
        );
        releaseOwner.resolve();
        yield* Effect.tryPromise(() => ownerSettled);
        expect(settled).toBe(true);
      } finally {
        releaseSnapshot.resolve();
        releaseOwner.resolve();
        try {
          yield* Effect.tryPromise(() => ownerSettled);
        } finally {
          vi.useRealTimers();
        }
      }
    })
  ));

it("cannot release queued hosted work before its ordinary predecessor settles", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const predecessor = Promise.withResolvers<void>();
      const service = makeAgentService({
        environment: {
          DB: db,
          HOSTED_AI_MODEL: approvedWorkersAiModel,
          AI: { run: () => Promise.reject(new Error("No admitted work")) },
        },
        userId: UserId.make(users[0]),
        scheduleRecovery: () => Promise.resolve(),
      });
      let released = false;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const accepted = Option.getOrThrow(
        service.accept({
          request: new Request("https://coordinator.internal/hosted-turn", {
            method: "POST",
            body: "{}",
          }),
          preceding: predecessor.promise,
        })
      );
      accepted.settled.then(
        () => {
          released = true;
        },
        () => undefined
      );
      try {
        yield* Effect.yieldNow;
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(160_001));
        vi.useRealTimers();
        yield* Effect.tryPromise(() => service.recover());
        for (let barrier = 0; barrier < 10; barrier += 1) {
          yield* Effect.tryPromise(() => db.prepare("SELECT 1").first());
        }
        expect(released).toBe(false);
      } finally {
        vi.useRealTimers();
        predecessor.resolve();
        yield* Effect.tryPromise(() => accepted.settled);
      }
      expect(released).toBe(true);
    })
  ));

it("bounds independent User retention at four and expires every selected User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const current = now();
      const scopedUsers = Array.from(
        { length: 9 },
        (_, index) => `a2000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`
      );
      yield* Effect.tryPromise(() =>
        db.batch(
          scopedUsers.flatMap((userId) => [
            db
              .prepare(
                "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
              )
              .bind(userId, current),
            db
              .prepare(
                "INSERT INTO hosted_compaction_attempts (user_id,day_ms,used) VALUES (?,0,1)"
              )
              .bind(userId),
          ])
        )
      );
      const filled = yield* Deferred.make<void>();
      const release = Promise.withResolvers<void>();
      let active = 0;
      let maximum = 0;
      let started = 0;
      const controlled = new Proxy(db, {
        get(target, property): unknown {
          if (property === "prepare") {
            return (sql: string): D1PreparedStatement => {
              const statement = target.prepare(sql);
              if (!sql.startsWith("DELETE FROM hosted_confirmations")) {
                return statement;
              }
              return new Proxy(statement, {
                get(prepared, method): unknown {
                  if (method === "bind") {
                    return (
                      ...values: Parameters<D1PreparedStatement["bind"]>
                    ): D1PreparedStatement => {
                      const bound = prepared.bind(...values);
                      return new Proxy(bound, {
                        get(native, operation): unknown {
                          if (operation === "run") {
                            return (): ReturnType<D1PreparedStatement["run"]> => {
                              started++;
                              maximum = Math.max(maximum, ++active);
                              if (active === 4) Deferred.doneUnsafe(filled, Effect.void);
                              return release.promise
                                .then(() => native.run())
                                .finally(() => {
                                  active--;
                                });
                            };
                          }
                          const value: unknown = Reflect.get(native, operation);
                          return typeof value === "function" ? value.bind(native) : value;
                        },
                      });
                    };
                  }
                  const value: unknown = Reflect.get(prepared, method);
                  return typeof value === "function" ? value.bind(prepared) : value;
                },
              });
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const owner = yield* makeAgentRetention({ db: controlled })
        .sweep(current)
        .pipe(Effect.forkChild);
      yield* Deferred.await(filled);
      yield* Effect.yieldNow;
      const held = { active, started, maximum };
      release.resolve();
      yield* Fiber.join(owner);
      expect(held).toEqual({ active: 4, started: 4, maximum: 4 });
      expect({ active, started, maximum }).toEqual({ active: 0, started: 9, maximum: 4 });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS retained FROM hosted_compaction_attempts").first()
        )
      ).toEqual({ retained: 0 });
    })
  ));

it("contains retention persistence failure behind the closed Agent failure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() => db.prepare("DROP TABLE hosted_turns").run());
      const outcome = yield* Effect.exit(makeAgentRetention({ db }).sweep(now()));
      assert.deepStrictEqual(outcome, Exit.fail(new AgentUnavailable()));
    })
  ));

it.each(["finish", "recover"] as const)(
  "counts the exact %s transition despite native D1 trigger writes",
  (operation) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        yield* Effect.tryPromise(() => installLifecycleAuditTriggers(db));
        const caller = yield* Effect.tryPromise(() => subject(0));
        const current = now();
        const snapshot = Option.getOrThrow(
          yield* readHostedSnapshot({ db, subject: caller, now: current })
        );
        const userId = UserId.make(users[0]);
        const selection = selectHostedSession({ snapshot, userId, now: current });
        const turnId = TranscriptTurnId.make(newId());
        yield* admitHostedTurn({
          db,
          channel: { _tag: "Browser", subject: caller },
          selection,
          text: TranscriptText.make("Trigger accounting"),
          now: current,
          id: turnId,
        });
        const pending = Option.getOrThrow(
          Option.getOrThrow(yield* readHostedSnapshot({ db, subject: caller, now: current }))
            .pending
        );
        const transition =
          operation === "finish"
            ? finishHostedTurn({
                db,
                userId,
                turnId,
                startedAtMs: current,
                result: { _tag: "Interrupted" },
                subject: caller,
                now: current,
              })
            : recoverHostedTurn({ db, userId, turn: pending, now: current });
        expect(yield* transition).toBe(true);
        expect(yield* transition).toBe(false);
        expect(
          (yield* Effect.tryPromise(() =>
            db.prepare("SELECT operation FROM lifecycle_audit").all()
          )).results
        ).toEqual([{ operation: "terminal" }]);
      })
    )
);

it("counts only selected Transcript rows when native D1 compaction triggers write", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() => installLifecycleAuditTriggers(db));
      const fixture = yield* closedContinuityFixture(db);
      const continuity = yield* readHostedContinuity({
        db,
        subject: fixture.caller,
        sessionId: fixture.sessionId,
        now: fixture.current,
        admittedWhatsAppTurn: Option.none(),
      });
      const compact = commitHostedCompaction({
        db,
        subject: fixture.caller,
        sessionId: fixture.sessionId,
        continuity,
        throughSequence: Option.getOrThrow(continuity.terminalThroughSequence),
        text: "Exact compacted evidence",
        signal: makeAbortController().signal,
      });
      expect(yield* compact).toBe(true);
      expect(yield* compact).toBe(false);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT operation FROM lifecycle_audit ORDER BY rowid").all()
        )).results
      ).toEqual([
        { operation: "terminal" },
        { operation: "transcript" },
        { operation: "transcript" },
      ]);
    })
  ));

it("awaits a dispatched compaction commit before releasing an interrupted owner", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const fixture = yield* closedContinuityFixture(db);
      const continuity = yield* readHostedContinuity({
        db,
        subject: fixture.caller,
        sessionId: fixture.sessionId,
        now: fixture.current,
        admittedWhatsAppTurn: Option.none(),
      });
      const throughSequence = Option.getOrThrow(continuity.terminalThroughSequence);
      const gate = gateCompactionBatch(db);
      const controller = makeAbortController();
      let settled = false;
      const owner = yield* commitHostedCompaction({
        db: gate.db,
        subject: fixture.caller,
        sessionId: fixture.sessionId,
        continuity,
        throughSequence,
        text: "Compacted exact evidence",
        signal: controller.signal,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            settled = true;
          })
        ),
        Effect.forkScoped
      );
      yield* Effect.tryPromise(() => gate.dispatched);
      controller.abort();
      const interrupted = yield* Fiber.interrupt(owner).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Effect.sync(() => expect(settled).toBe(false)).pipe(
        Effect.ensuring(Effect.sync(gate.release))
      );
      yield* Fiber.join(interrupted);
      expect(settled).toBe(true);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT text FROM hosted_compacted_conversations").all()
        )).results
      ).toEqual([{ text: "Compacted exact evidence" }]);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT id FROM transcript_entries").all()))
          .results
      ).toEqual([]);
    }).pipe(Effect.scoped)
  ));

it.each(continuityCorruptions)(
  "closes corrupt retained $name into typed failure without partial continuity or inference",
  ({ snapshot, sql }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        const fixture = yield* closedContinuityFixture(db);
        if (!snapshot) {
          yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER transcript_no_update").run());
        }
        yield* Effect.tryPromise(() => db.prepare(sql).run());
        const work = snapshot
          ? readHostedSnapshot({ db, subject: fixture.caller, now: fixture.current }).pipe(
              Effect.asVoid
            )
          : readHostedContinuity({
              db,
              subject: fixture.caller,
              sessionId: fixture.sessionId,
              now: fixture.current,
              admittedWhatsAppTurn: Option.none(),
            }).pipe(Effect.asVoid);
        const exit = yield* Effect.exit(work);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(false);
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
            Schema.SchemaError
          );
        }
        const model = vi.fn(() => Promise.resolve(reply("Must not run")));
        const service = makeAgentService({
          environment: {
            DB: db,
            KAPSO_API_KEY: "test-kapso-api-key",
            HOSTED_AI_MODEL: approvedWorkersAiModel,
            AI: { run: model },
          },
          userId: UserId.make(users[0]),
          scheduleRecovery: () => Promise.resolve(),
        });
        const accepted = Option.getOrThrow(
          service.accept({
            request: new Request("https://coordinator.internal/hosted-turn", {
              method: "POST",
              body: encodeJson({
                userId: fixture.caller.userId,
                sessionId: fixture.caller.id,
                digest: Array.from(fixture.caller.digest),
                text: "A new Turn",
              }),
            }),
            preceding: Promise.resolve(),
          })
        );
        const response = yield* Effect.tryPromise(() => accepted.response);
        yield* Effect.tryPromise(() => accepted.settled);
        expect(response.status).toBe(503);
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({ status: "unavailable" });
        expect(model).not.toHaveBeenCalled();
      })
    )
);

it("releases an admitted Consent basis only for its exact User and still-Pending Turn", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const caller = yield* Effect.tryPromise(() => subject(0));
      const current = now();
      const snapshot = yield* readHostedSnapshot({ db, subject: caller, now: current });
      if (Option.isNone(snapshot)) return yield* Effect.die("missing fixture authority");
      const userId = UserId.make(users[0]);
      const turnId = TranscriptTurnId.make(newId());
      yield* admitHostedTurn({
        db,
        channel: { _tag: "Browser", subject: caller },
        selection: selectHostedSession({ snapshot: snapshot.value, userId, now: current }),
        text: TranscriptText.make("One admitted purpose"),
        now: current,
        id: turnId,
      });
      const basis = yield* readAdmittedHostedConsent({ db, userId, turnId });
      expect(Option.map(basis, (value) => value.grantId)).toEqual(Option.some(grants[0]));
      expect(
        yield* readAdmittedHostedConsent({ db, userId: UserId.make(users[1]), turnId })
      ).toEqual(Option.none());
      yield* recoverHostedTurn({
        db,
        userId,
        turn: { id: turnId, started_at_ms: current, proposed_at_ms: null },
        now: current + 135_001,
      });
      expect(yield* readAdmittedHostedConsent({ db, userId, turnId })).toEqual(Option.none());
      expect((yield* Effect.tryPromise(() => retained({ db, user: users[1] }))).results).toEqual(
        []
      );
    })
  ));

it("uses the owner's Clock throughout hosted preflight, inference and delivery scheduling", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const caller = yield* Effect.tryPromise(() => subject(0));
      const model = yield* Effect.tryPromise(() =>
        inference(() => Promise.resolve(reply("Clock-owned reply")))
      );
      const liveClock = yield* Clock.Clock;
      let decisionTime = (yield* Clock.currentTimeMillis) + 1_000;
      const admittedAt = decisionTime;
      const observed: Array<number> = [];
      const scheduled: Array<number> = [];
      const clock: Clock.Clock = {
        currentTimeNanos: liveClock.currentTimeNanos,
        currentTimeNanosUnsafe: () => liveClock.currentTimeNanosUnsafe(),
        monotonicTimeNanos: liveClock.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
        sleep: (duration) => liveClock.sleep(duration),
        currentTimeMillis: Effect.sync(() => decisionTime),
        currentTimeMillisUnsafe: () => decisionTime,
      };
      const inheritedModel: HostedInferenceService = {
        ...model,
        prepareText: (input) =>
          model.prepareText(input).pipe(
            Effect.map((prepared) => ({
              ...prepared,
              execute: Effect.gen(function* () {
                observed.push(yield* Clock.currentTimeMillis);
                decisionTime += 1_000;
                return yield* prepared.execute;
              }),
            }))
          ),
      };
      const response = yield* completeHostedTurnWithAlarm({
        db,
        subject: caller,
        bucket: Option.none(),
        executeMutation: Option.none(),
        text: TranscriptText.make("Clock-owned request"),
        inference: inheritedModel,
        deliver: browserHostedDelivery,
        signal: makeAbortController().signal,
        scheduleRecovery: (due) => {
          scheduled.push(due);
          return Promise.resolve();
        },
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(response.status).toBe(202);
      expect(observed).toEqual([admittedAt]);
      expect(scheduled).toEqual([
        admittedAt + 135_000,
        admittedAt + 1_000 + deliveryAcknowledgmentWindowMs,
      ]);
      const visible = yield* Schema.decodeUnknownEffect(VisibleReply)(
        yield* Effect.tryPromise(() => response.json())
      );
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT started_at_ms FROM hosted_turns WHERE id = ?")
            .bind(visible.turnId)
            .first()
        )
      ).toEqual({ started_at_ms: admittedAt });
    })
  ));

it("admits a web-provider onboarding grant through the native Agent service and returns a delivery proposal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const credentials = yield* Effect.tryPromise(() => subject(0));
      const attemptId = "a".repeat(43);
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE onboarding_consent_records SET id = ? WHERE user_id = ?")
          .bind(attemptId, users[0])
          .run()
      );
      const model = vi.fn(() => Promise.resolve(reply("Conexión verificada")));
      const service = makeAgentService({
        environment: { DB: db, HOSTED_AI_MODEL: approvedWorkersAiModel, AI: { run: model } },
        userId: UserId.make(users[0]),
        scheduleRecovery: () => Promise.resolve(),
      });
      const accepted = Option.getOrThrow(
        service.accept({
          request: new Request("https://coordinator.internal/hosted-turn", {
            method: "POST",
            body: encodeJson({
              userId: credentials.userId,
              sessionId: credentials.id,
              digest: Array.from(credentials.digest),
              text: "Hola",
            }),
          }),
          preceding: Promise.resolve(),
        })
      );
      const response = yield* Effect.tryPromise(() => accepted.response);
      yield* Effect.tryPromise(() => accepted.settled);
      expect(response.status).toBe(202);
      expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
        text: "Conexión verificada",
      });
      expect(model).toHaveBeenCalledOnce();
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toMatchObject([{ status: "pending", kind: "user", text: "Hola" }]);
    })
  ));

it("returns safe quota feedback and retains a terminal failure without an assistant reply", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const credentials = yield* Effect.tryPromise(() => subject(0));
      const model = vi.fn(() =>
        Promise.resolve(
          Response.json(
            { errors: [{ code: 4006, message: "private provider quota detail" }] },
            { status: 429 }
          )
        )
      );
      const service = makeAgentService({
        environment: { DB: db, HOSTED_AI_MODEL: approvedWorkersAiModel, AI: { run: model } },
        userId: UserId.make(users[0]),
        scheduleRecovery: () => Promise.resolve(),
      });
      const accepted = Option.getOrThrow(
        service.accept({
          request: new Request("https://coordinator.internal/hosted-turn", {
            method: "POST",
            body: encodeJson({
              userId: credentials.userId,
              sessionId: credentials.id,
              digest: Array.from(credentials.digest),
              text: "Hola",
            }),
          }),
          preceding: Promise.resolve(),
        })
      );
      const response = yield* Effect.tryPromise(() => accepted.response);
      yield* Effect.tryPromise(() => accepted.settled);
      expect(response.status).toBe(429);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({
        status: "provider_quota_exceeded",
      });
      expect(
        (yield* Effect.tryPromise(() => retained({ db, user: users[0] }))).results
      ).toMatchObject([
        { status: "failed", kind: "user", text: "Hola" },
        { status: "failed", kind: "failed", text: null },
      ]);
      expect(model).toHaveBeenCalledOnce();
    })
  ));

it("confirms a hosted Transaction deletion exactly once and retains the hidden original", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() =>
        seedHistoryTransaction({ db, counterparty: "Deletion fixture" })
      );
      const id = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT id FROM transactions WHERE user_id = ?")
          .bind(users[0])
          .first<string>("id")
      );
      expect(id).toBeTruthy();
      let requests = 0;
      const coordinator = coordinatorFor({
        options: { index: 0, sandboxPhoneNumberId: "" },
        db,
        run: () => {
          requests++;
          return Promise.resolve(
            Response.json({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "delete-request",
                        type: "function",
                        function: {
                          name: "transactions__deleteTransaction",
                          arguments: encodeJson({ params: { id } }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
            })
          );
        },
      });
      const credential = yield* Effect.tryPromise(() => subject(0));
      const send = (text: string): Promise<Response> =>
        coordinator.fetch(
          new Request("https://coordinator.internal/hosted-turn", {
            method: "POST",
            body: encodeJson({
              userId: credential.userId,
              sessionId: credential.id,
              digest: Array.from(credential.digest),
              text,
            }),
          })
        );
      const response = yield* Effect.tryPromise(() => send("Elimina la transacción de prueba"));
      const challenge = yield* Effect.tryPromise(() =>
        acknowledgeVisibleReply({ db, index: 0, response })
      );
      expect(challenge).toContain("transactions.deleteTransaction");
      expect(challenge).toContain(id);
      const command = challenge.split("Responde exactamente: ")[1] ?? "";
      expect(command).toMatch(/^CONFIRMAR [0-9a-f]{64}$/u);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT COUNT(*) AS total FROM dashboard_effective_source WHERE user_id = ?")
            .bind(users[0])
            .first<number>("total")
        )
      ).toBe(1);
      const confirmed = yield* Effect.tryPromise(() => send(command));
      expect(
        yield* Effect.tryPromise(() =>
          acknowledgeVisibleReply({ db, index: 0, response: confirmed })
        )
      ).toBe("Operación confirmada.");
      expect(requests).toBe(1);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT COUNT(*) AS total FROM dashboard_effective_source WHERE user_id = ?")
            .bind(users[0])
            .first<number>("total")
        )
      ).toBe(0);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT COUNT(*) AS total FROM transactions WHERE user_id = ? AND deleted_at_ms IS NOT NULL"
            )
            .bind(users[0])
            .first<number>("total")
        )
      ).toBe(1);
      expect((yield* Effect.tryPromise(() => send(command))).status).toBe(401);
    })
  ));

it("a recurring lifecycle challenge exposes a readable browser review and confirms the bound edit once", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const planId = "40000000-0000-4000-8000-000000000991";
      yield* seedRecurringReview({ db, planId });
      const reviewCommand = {
        expectedRevision: 1,
        edit: {
          kind: "lifecycle" as const,
          planId: RecurringPlanId.make(planId),
          date: "2026-10-15",
          action: "stop" as const,
        },
      };
      expect(
        yield* describeRecurringLifecycle({ db, userId: users[1], command: reviewCommand })
      ).toEqual(Option.none());
      expect(
        yield* describeRecurringLifecycle({
          db,
          userId: users[0],
          command: { ...reviewCommand, expectedRevision: 0 },
        })
      ).toEqual(Option.none());
      const model = vi.fn(() =>
        Promise.resolve(
          Response.json({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "stop-plan",
                      type: "function",
                      function: {
                        name: "recurringPlans__applyRecurringEdit",
                        arguments: encodeJson({
                          payload: {
                            expectedRevision: 1,
                            edit: { kind: "lifecycle", planId, date: "2026-10-15", action: "stop" },
                          },
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
          })
        )
      );
      const coordinator = coordinatorFor({
        options: { index: 0, sandboxPhoneNumberId: "" },
        db,
        run: model,
      });
      const credential = yield* Effect.tryPromise(() => subject(0));
      const send = (text: string): Promise<Response> =>
        coordinator.fetch(
          new Request("https://coordinator.internal/hosted-turn", {
            method: "POST",
            body: encodeJson({
              userId: credential.userId,
              sessionId: credential.id,
              digest: Array.from(credential.digest),
              text,
            }),
          })
        );
      const response = yield* Effect.tryPromise(() => send("Deja de seguir Plan de prueba"));
      const proposed = yield* Schema.decodeUnknownEffect(HostedTurnProposal)(
        yield* Effect.tryPromise(() => response.clone().json())
      );
      expect(proposed.text).toContain("Dejar de seguir «Plan de prueba» desde el 15-10-2026");
      expect(proposed.text).not.toContain("CONFIRMAR");
      expect(proposed.text).not.toContain(planId);
      expect(proposed.text).not.toContain("applyRecurringEdit");
      const command = proposed.confirmation?.command ?? "";
      expect(command).toMatch(/^CONFIRMAR [0-9a-f]{64}$/u);
      const metadata = { db, userId: credential.userId, turnId: proposed.turnId, now: now() };
      expect(yield* readBrowserConfirmation({ ...metadata, userId: users[1] })).toEqual(
        Option.none()
      );
      expect(yield* readBrowserConfirmation({ ...metadata, now: now() + 600_001 })).toEqual(
        Option.none()
      );
      const progress = yield* readHostedProgress({
        db,
        subject: credential,
        turnId: proposed.turnId,
        scheduleRecovery: () => Promise.resolve(),
      });
      expect(yield* Effect.tryPromise(() => progress.clone().json())).toMatchObject({
        text: proposed.text,
        confirmation: { command },
      });
      expect((yield* Effect.tryPromise(() => send(command))).status).toBe(409);
      yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response: progress }));
      const confirmed = yield* Effect.tryPromise(() => send(command));
      expect(
        yield* Effect.tryPromise(() =>
          acknowledgeVisibleReply({ db, index: 0, response: confirmed })
        )
      ).toBe("Operación confirmada.");
      expect(yield* readBrowserConfirmation(metadata)).toEqual(Option.none());
      const stored = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT document_json FROM recurring_plan_documents WHERE user_id=?")
          .bind(users[0])
          .first<string>("document_json")
      );
      expect(stored).toContain('"stoppedOn":"2026-10-15"');
      const transcript = yield* Effect.tryPromise(() => retained({ db, user: users[0] }));
      expect(transcript.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "assistant", text: proposed.text }),
        ])
      );
      expect(transcript.results).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "assistant", text: command })])
      );

      const replay = yield* Effect.tryPromise(() => send(command));
      expect(replay.status).toBe(401);
      expect(model).toHaveBeenCalledOnce();
    })
  ));

it("model-written confirmation prose cannot produce browser approval metadata", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const credential = yield* Effect.tryPromise(() => subject(0));
      const text = `Dejar de seguir Plan de prueba. Responde exactamente: CONFIRMAR ${"a".repeat(64)}`;
      const coordinator = coordinatorFor({
        options: { index: 0, sandboxPhoneNumberId: "" },
        db,
        run: () => Promise.resolve(reply(text)),
      });
      const response = yield* Effect.tryPromise(() =>
        coordinator.fetch(
          new Request("https://coordinator.internal/hosted-turn", {
            method: "POST",
            body: encodeJson({
              userId: credential.userId,
              sessionId: credential.id,
              digest: Array.from(credential.digest),
              text: "Solo consulta",
            }),
          })
        )
      );
      const visible = yield* Schema.decodeUnknownEffect(HostedTurnProposal)(
        yield* Effect.tryPromise(() => response.clone().json())
      );
      expect(visible.confirmation).toBeUndefined();
      expect(
        yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response }))
      ).toBe(text);
    })
  ));
