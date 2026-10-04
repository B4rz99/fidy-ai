import { afterAll } from "vitest";
import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
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
} from "../weekly-summary.test-fixture";
import {
  expireProactiveTranscript,
  prepareProactiveTranscript,
  readProactiveTranscript,
} from "./operations";

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
      yield* expireProactiveTranscript({ ...scope, now: deadline });
      const retained = yield* Effect.tryPromise(() =>
        input.db.prepare("SELECT 1 FROM proactive_transcript_entries").first()
      );
      expect(retained).toBeNull();
      expect(
        Option.getOrThrow(yield* findInsight({ ...scope, id: input.insightEventId })).lifecycleState
      ).toBe("delivered");
    })
);
