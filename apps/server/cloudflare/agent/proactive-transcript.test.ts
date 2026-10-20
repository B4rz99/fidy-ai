import { applyTestMigration } from "../d1-test-fixture";
import { afterAll } from "vitest";
import { expect, it } from "@effect/vitest";
import { Clock, DateTime, Effect, Exit, Option, Schema } from "effect";
import { AgentUnavailable } from "./contract";
import { type InsightUnavailable } from "../insights/contract";
import {
  findInsight,
  findInsightAttempt,
  findWeeklySummaryReport,
  materializeWeeklySummary,
  prepareWeeklyDeliverySettlement,
  weeklyReportDeliveryQuery,
} from "../insights/operations";
import { makeInsightTemplateSender } from "../../src/shell/channels/whatsapp/runtime";
import { WhatsAppProviderMessageId } from "../../src/shell/channels/whatsapp/contract";
import {
  InsightRecipient,
  type InsightWhatsAppReconciliation,
  type InsightWhatsAppStage,
  type WhatsAppUnavailable,
} from "../whatsapp/contract";
import {
  contextualProactiveInsightQuery,
  insightVerifiedDeliveryQuery,
  insightVerifiedTranscriptQuery,
  reconcileInsightStatus,
  stageInsightDelivery,
  startInsightSend,
} from "../whatsapp/operations";
import {
  activateWeeklySummary,
  seedForeignProviderEvidence,
  seedWeeklySummaryActivity,
  setWeeklySummaryAttention,
  weeklySummaryDatabaseAt,
  weeklySummaryOtherUser,
  weeklySummaryTestCaller,
  weeklySummaryTestDatabase,
  weeklySummaryTestDatabases,
  weeklySummaryTestNow,
  weeklySummaryTestUser,
  withdrawWeeklyFixtureConsent,
} from "../weekly-summary.test-fixture";
import {
  expireProactiveTranscript,
  prepareProactiveTranscript,
  readProactiveTranscript,
} from "./operations";

import { readContextualProactiveReply } from "./internal/proactive-transcript";
import { makeAgentErasureStores, makeAgentRetention } from "./runtime";

const sender = makeInsightTemplateSender({
  configuration: {
    name: "fidy_weekly_summary",
    language: "es",
    approval: "approved",
    body: "Tu resumen semanal: {{1}} Consulta tus movimientos en Fidy.",
  },
  outboundHttp: { execute: () => Effect.die("test makes no provider call") },
});
const recipient = Schema.decodeSync(InsightRecipient)({
  portfolioId: weeklySummaryTestCaller.businessPortfolioId,
  bsuid: weeklySummaryTestCaller.businessScopedUserId,
  businessPhoneNumberId: "123456789",
});
const deliveredFixture = (
  db: D1Database,
  clock: Readonly<{ now: DateTime.Utc; at: string }> = {
    now: weeklySummaryTestNow,
    at: "2026-08-04T12:00:00.000Z",
  }
): Effect.Effect<InsightWhatsAppStage, InsightUnavailable> =>
  Effect.gen(function* () {
    const schedule = yield* activateWeeklySummary({ db, now: clock.now });
    yield* seedWeeklySummaryActivity({ db, at: clock.at });
    const work = {
      db,
      userId: weeklySummaryTestUser,
      id: schedule.id,
      now: schedule.nextScheduledAt,
    };
    const generated = yield* materializeWeeklySummary(work);
    if (generated._tag !== "Created") {
      return yield* Effect.die("Expected report");
    }
    const report = Option.getOrThrow(yield* findWeeklySummaryReport({ ...work, id: generated.id }));
    return {
      db,
      userId: weeklySummaryTestUser,
      insightEventId: generated.id,
      grantId: report.consentGrantId,
      recipient,
      summary: report.presentation,
      scheduledAt: work.now,
      expiresAt: report.expiresAt,
      timeZone: schedule.timeZone,
      now: work.now,
      queuedAdmission: Option.none(),
      guard: weeklyReportDeliveryQuery({ userId: work.userId, insightEventId: generated.id }),
      sender,
    };
  });
const settlement = (input: InsightWhatsAppStage): ReadonlyArray<D1PreparedStatement> => {
  const scope = {
    userId: input.userId,
    insightEventId: input.insightEventId,
    now: DateTime.toEpochMillis(input.now),
  };
  return [
    ...prepareProactiveTranscript({
      ...scope,
      db: input.db,
      proof: insightVerifiedTranscriptQuery(scope),
    }),
    ...prepareWeeklyDeliverySettlement({
      ...scope,
      thresholds: { askAfter: 4, pauseAfter: 2 },
      db: input.db,
      proof: insightVerifiedDeliveryQuery(scope),
    }),
  ];
};
const verify = (
  input: InsightWhatsAppStage
): Effect.Effect<InsightWhatsAppReconciliation, WhatsAppUnavailable> =>
  Effect.gen(function* () {
    yield* stageInsightDelivery(input);
    const claim = yield* startInsightSend(input);
    if (claim._tag !== "Ready") {
      return yield* Effect.die("Expected ready claim");
    }
    return yield* reconcileInsightStatus({
      db: input.db,
      admission: {
        userId: input.userId,
        correlationToken: claim.correlationToken,
        businessPhoneNumberId: recipient.businessPhoneNumberId,
        providerMessageId: WhatsAppProviderMessageId.make("wamid.proactive"),
        outcome: "delivered",
        occurredAtMs: DateTime.toEpochMillis(input.now),
        receivedAtMs: DateTime.toEpochMillis(input.now),
      },
    });
  });
afterAll(() => weeklySummaryTestDatabases.dispose());
it.live("returns typed AgentUnavailable for corrupt retained proactive Transcript time", () =>
  Effect.gen(function* () {
    const input = yield* deliveredFixture(yield* weeklySummaryTestDatabase);
    yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "INSERT INTO proactive_transcript_entries (id,user_id,insight_event_id,occurred_at_ms,text,expires_at_ms) VALUES (?,?,?,?,?,?)"
        )
        .bind(
          "11111111-1111-4111-8111-111111111111",
          input.userId,
          input.insightEventId,
          8_640_000_000_000_001,
          "Verified reply",
          8_640_000_000_000_001 + 2_592_000_000
        )
        .run()
    );
    const result = yield* Effect.exit(
      readProactiveTranscript({
        db: input.db,
        userId: input.userId,
        insightEventId: input.insightEventId,
        now: input.now.epochMilliseconds,
      })
    );
    expect(result).toEqual(Exit.fail(new AgentUnavailable()));
  })
);
it.live(
  "contextual financial reads bind User and live association, and a cached proof cannot survive Consent withdrawal",
  () =>
    Effect.gen(function* () {
      const input = yield* deliveredFixture(yield* weeklySummaryTestDatabase);
      yield* verify(input);
      yield* Effect.tryPromise(() => input.db.batch([...settlement(input)]));
      const proof = contextualProactiveInsightQuery({
        userId: input.userId,
        portfolioId: recipient.portfolioId,
        bsuid: recipient.bsuid,
        replyToMessageId: Option.some(WhatsAppProviderMessageId.make("wamid.proactive")),
      });
      const context = {
        db: input.db,
        userId: input.userId,
        now: input.now.epochMilliseconds,
        proof,
      };
      const visible = Option.getOrThrow(yield* readContextualProactiveReply(context));
      expect(visible.userId).toBe(input.userId);
      expect(visible.entry.text).toBe((yield* sender.prepare(input.summary)).text);
      expect(
        Option.isNone(
          yield* readContextualProactiveReply({ ...context, userId: weeklySummaryOtherUser })
        )
      ).toBe(true);
      yield* Effect.tryPromise(() =>
        input.db
          .prepare("UPDATE users SET whatsapp_bsuid='CO.changed' WHERE id=?")
          .bind(input.userId)
          .run()
      );
      expect(Option.isNone(yield* readContextualProactiveReply(context))).toBe(true);
      yield* Effect.tryPromise(() =>
        input.db
          .prepare("UPDATE users SET whatsapp_bsuid=? WHERE id=?")
          .bind(recipient.bsuid, input.userId)
          .run()
      );
      yield* withdrawWeeklyFixtureConsent({ db: input.db, userId: input.userId, now: context.now });
      expect(Option.isNone(yield* readContextualProactiveReply(context))).toBe(true);
    })
);

it.live(
  "copies exact verified text and actual send evidence atomically once without inventing a Turn or regressing read",
  () =>
    Effect.gen(function* () {
      const input = yield* deliveredFixture(yield* weeklySummaryTestDatabase);
      const scope = {
        db: input.db,
        userId: input.userId,
        insightEventId: input.insightEventId,
        now: DateTime.toEpochMillis(input.now),
      };
      yield* Effect.tryPromise(() => input.db.batch([...settlement(input)]));
      expect(Option.isNone(yield* readProactiveTranscript(scope))).toBe(true);
      yield* verify(input);
      yield* seedForeignProviderEvidence(input.db);
      const rolledBack = yield* Effect.exit(
        Effect.tryPromise(() =>
          input.db.batch([
            ...settlement(input),
            input.db.prepare("SELECT abs(-9223372036854775808)"),
          ])
        )
      );
      expect(rolledBack._tag).toBe("Failure");
      expect(Option.isNone(yield* readProactiveTranscript(scope))).toBe(true);
      expect(
        Option.getOrThrow(yield* findInsight({ ...scope, id: input.insightEventId })).lifecycleState
      ).toBe("pending");
      yield* setWeeklySummaryAttention({ db: input.db, id: input.insightEventId, state: "read" });
      yield* Effect.tryPromise(() => input.db.batch([...settlement(input)]));
      const entry = Option.getOrThrow(yield* readProactiveTranscript(scope));
      expect(entry.text).toBe((yield* sender.prepare(input.summary)).text);
      expect("turnId" in entry).toBe(false);
      expect(entry.insightEventId).toBe(input.insightEventId);
      expect(
        Option.getOrThrow(yield* findInsight({ ...scope, id: input.insightEventId })).lifecycleState
      ).toBe("read");
      expect(
        Option.getOrThrow(yield* findInsightAttempt({ ...scope, id: input.insightEventId }))
          .providerMessageId
      ).toBe("wamid.proactive");
      expect(
        Option.isNone(yield* readProactiveTranscript({ ...scope, userId: weeklySummaryOtherUser }))
      ).toBe(true);
      yield* Effect.tryPromise(() => input.db.batch([...settlement(input)]));
      const count = yield* Effect.tryPromise(() =>
        input.db.prepare("SELECT count(*) AS total FROM proactive_transcript_entries").first()
      );
      expect(count).toEqual({ total: 1 });
    })
);
it.live(
  "deletes proactive Transcript at the fixed deadline without needing another User message",
  () =>
    Effect.gen(function* () {
      const now = DateTime.makeUnsafe("2020-08-09T12:00:00Z");
      const input = yield* deliveredFixture(yield* weeklySummaryDatabaseAt(now), {
        now,
        at: "2020-08-04T12:00:00.000Z",
      });
      yield* verify(input);
      yield* Effect.tryPromise(() => input.db.batch([...settlement(input)]));
      const scope = {
        db: input.db,
        userId: input.userId,
        insightEventId: input.insightEventId,
        now: DateTime.toEpochMillis(input.now),
      };
      expect(Option.isSome(yield* readProactiveTranscript(scope))).toBe(true);
      const deadline = DateTime.toEpochMillis(DateTime.add(input.now, { days: 30 }));
      expect(Option.isNone(yield* readProactiveTranscript({ ...scope, now: deadline }))).toBe(true);
      yield* Effect.tryPromise(() =>
        input.db.prepare("DROP TABLE hosted_compaction_attempts").run()
      );
      const sweep = yield* Effect.exit(makeAgentRetention({ db: input.db }).sweep(deadline));
      expect(sweep._tag).toBe("Failure");
      const retained = yield* Effect.tryPromise(() =>
        input.db.prepare("SELECT 1 FROM proactive_transcript_entries").first()
      );
      expect(retained).toBeNull();
      expect(
        Option.getOrThrow(yield* findInsight({ ...scope, id: input.insightEventId })).lifecycleState
      ).toBe("delivered");
    })
);

it.live(
  "preserves colliding message identities, insight ordering, grouped links and independent expiry through consolidation",
  () =>
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => weeklySummaryTestDatabases.acquire());
      const directory = new URL("../migrations/", import.meta.url);
      const names = [...new Bun.Glob("*.sql").scanSync(directory.pathname)]
        .filter((name) => name < "0131_")
        .sort();
      for (const name of names) {
        yield* Effect.tryPromise(() =>
          applyTestMigration({ db, source: new URL(name, directory) })
        );
      }
      const user = weeklySummaryTestUser;
      const other = weeklySummaryOtherUser;
      const sharedId = "a1000000-0000-4000-8000-000000000001";
      const foreignId = "a1000000-0000-4000-8000-000000000002";
      const event = "a2000000-0000-4000-8000-000000000001";
      const foreignEvent = "a2000000-0000-4000-8000-000000000002";
      const groupedEvent = "a2000000-0000-4000-8000-000000000003";
      const unlinkedEvent = "a2000000-0000-4000-8000-000000000004";
      const deadline = weeklySummaryTestNow.epochMilliseconds + 2_592_000_000;
      for (const subject of [user, other]) {
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','UTC',0)"
            )
            .bind(subject)
            .run()
        );
      }
      for (const [id, subject] of [
        [event, user],
        [foreignEvent, other],
        [groupedEvent, user],
        [unlinkedEvent, other],
      ]) {
        yield* Effect.tryPromise(() =>
          db
            .prepare(`INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json)
        VALUES(?,?,'weekly-summary',?,1,'CO','es-CO','UTC','2026-08-04T00:00:00Z','[]')`)
            .bind(id, subject, id)
            .run()
        );
      }
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO proactive_transcript_entries(sequence,id,user_id,insight_event_id,occurred_at_ms,text,expires_at_ms) VALUES(7,?,?,?,?,?,?)"
            )
            .bind(
              sharedId,
              user,
              event,
              weeklySummaryTestNow.epochMilliseconds,
              "Financial",
              deadline
            ),
          db
            .prepare(
              "INSERT INTO proactive_transcript_entries(sequence,id,user_id,insight_event_id,occurred_at_ms,text,expires_at_ms) VALUES(9,?,?,?,?,?,?)"
            )
            .bind(
              foreignId,
              other,
              foreignEvent,
              weeklySummaryTestNow.epochMilliseconds + 1,
              "Other User",
              deadline + 1
            ),
          db
            .prepare("INSERT INTO proactive_transcript_event_links VALUES(?,?,?)")
            .bind(user, sharedId, groupedEvent),
          db
            .prepare(
              "INSERT INTO proactive_message_transcript_entries VALUES(?,?,?,'reminder-question',?,'Prompt',?)"
            )
            .bind(sharedId, user, event, weeklySummaryTestNow.epochMilliseconds, deadline + 10_000),
          db.prepare(
            "UPDATE sqlite_sequence SET seq=100 WHERE name='proactive_transcript_entries'"
          ),
        ])
      );
      const insightsBefore = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM proactive_transcript_entries ORDER BY sequence").all()
      );
      const messagesBefore = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM proactive_message_transcript_entries").all()
      );
      const linksBefore = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT user_id,transcript_id,insight_event_id FROM proactive_transcript_event_links ORDER BY insight_event_id"
          )
          .all()
      );
      yield* Effect.tryPromise(() =>
        applyTestMigration({ db, source: new URL("0131_proactive_transcript.sql", directory) })
      );
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT sequence,id,user_id,insight_event_id,occurred_at_ms,text,expires_at_ms FROM proactive_transcript_entries WHERE kind='insight' ORDER BY sequence"
            )
            .all()
        )).results
      ).toEqual(insightsBefore.results);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT id,user_id,delivery_id,role,occurred_at_ms,text,expires_at_ms FROM proactive_transcript_entries WHERE kind='message'"
            )
            .all()
        )).results
      ).toEqual(messagesBefore.results);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT user_id,transcript_id,insight_event_id FROM proactive_transcript_event_links ORDER BY insight_event_id"
            )
            .all()
        )).results
      ).toEqual(linksBefore.results);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT sequence FROM proactive_transcript_entries WHERE kind='message'")
            .first<number>("sequence")
        )
      ).toBeGreaterThan(100);
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare(
              "INSERT INTO proactive_transcript_event_links(user_id,transcript_id,insight_event_id) VALUES(?,?,?)"
            )
            .bind(other, sharedId, unlinkedEvent)
            .run()
        ).rejects.toThrow("FOREIGN KEY")
      );
      const reference = "a3000000-0000-4000-8000-000000000001";
      const current = yield* Clock.currentTimeMillis;
      const decision = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        dispositions: {
          conversation: { action: "Retain", retention: { untilMs: current + 86_400_000 } },
        },
      });
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json) VALUES(?,?,0,'Archiving',?)"
            )
            .bind(reference, user, decision),
          db
            .prepare(
              "INSERT INTO erasure_steps(request_id,store_id,data_class) VALUES(?,'proactive_transcript_entries','conversation')"
            )
            .bind(reference),
        ])
      );
      const store = makeAgentErasureStores(db).find(
        (value) => value.id === "proactive_transcript_entries"
      );
      if (store === undefined) return yield* Effect.die("Missing proactive transcript store");
      expect(yield* store.archive({ userId: user, reference })).toBe(true);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT json_extract(body,'$.kind') AS kind,json_extract(body,'$.text') AS text FROM erasure_archives WHERE request_id=? ORDER BY kind"
            )
            .bind(reference)
            .all()
        )).results
      ).toEqual([
        { kind: "insight", text: "Financial" },
        { kind: "message", text: "Prompt" },
      ]);
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE erasure_requests SET state='Draining' WHERE id=?").bind(reference).run()
      );
      yield* expireProactiveTranscript({ db, userId: user, now: deadline });
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT kind,text FROM proactive_transcript_entries ORDER BY sequence").all()
        )).results
      ).toEqual([
        { kind: "insight", text: "Other User" },
        { kind: "message", text: "Prompt" },
      ]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT insight_event_id FROM proactive_transcript_event_links").all()
        )).results
      ).toEqual([{ insight_event_id: foreignEvent }]);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
      ).toEqual([]);
    })
);
