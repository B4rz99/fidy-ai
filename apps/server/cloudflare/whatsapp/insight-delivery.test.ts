import { afterAll } from "vitest";
import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { makeInsightTemplateSender } from "../../src/shell/channels/whatsapp/runtime";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import { createWeeklyConsentOffer, recordWeeklyConsentDisclosure } from "../consent/operations";
import {
  findWeeklySummaryReport,
  materializeWeeklySummary,
  recordWeeklySummaryDecision,
  weeklyReportDeliveryQuery,
} from "../insights/operations";
import {
  activateWeeklySummary,
  seedWeeklySummaryActivity,
  weeklySummaryOtherUser,
  weeklySummaryTestCaller,
  weeklySummaryTestDatabase,
  weeklySummaryTestDatabases,
  weeklySummaryTestNow,
  weeklySummaryTestUser,
} from "../weekly-summary.test-fixture";
import { type InsightUnavailable } from "../insights/contract";
import { InsightRecipient, type InsightWhatsAppStage } from "./contract";
import {
  reconcileInsightStatus,
  recordInsightSend,
  stageInsightDelivery,
  startInsightSend,
} from "./operations";

const sender = makeInsightTemplateSender({
  configuration: {
    name: "fidy_weekly_summary",
    language: "es",
    approval: "approved",
    body: "Tu resumen semanal: {{1}} Consulta tus movimientos en Fidy.",
  },
  outboundHttp: { execute: () => Effect.die("staging and claim must not call the provider") },
});
const recipient = Schema.decodeSync(InsightRecipient)({
  portfolioId: weeklySummaryTestCaller.businessPortfolioId,
  bsuid: weeklySummaryTestCaller.businessScopedUserId,
  businessPhoneNumberId: "123456789",
});
const prepare = (db: D1Database): Effect.Effect<InsightWhatsAppStage, InsightUnavailable> =>
  Effect.gen(function* () {
    const schedule = yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
    yield* seedWeeklySummaryActivity({ db, at: "2026-08-04T12:00:00.000Z" });
    const outcome = yield* materializeWeeklySummary({
      db,
      userId: weeklySummaryTestUser,
      id: schedule.id,
      now: schedule.nextScheduledAt,
    });
    if (outcome._tag !== "Created") {
      return yield* Effect.die("Expected report");
    }
    const report = Option.getOrThrow(
      yield* findWeeklySummaryReport({ db, userId: weeklySummaryTestUser, id: outcome.id })
    );
    return {
      db,
      userId: weeklySummaryTestUser,
      insightEventId: outcome.id,
      grantId: report.consentGrantId,
      recipient,
      summary: report.presentation,
      scheduledAt: schedule.nextScheduledAt,
      expiresAt: report.expiresAt,
      timeZone: schedule.timeZone,
      now: schedule.nextScheduledAt,
      guard: weeklyReportDeliveryQuery({
        userId: weeklySummaryTestUser,
        insightEventId: outcome.id,
      }),
      sender,
    };
  });
afterAll(() => weeklySummaryTestDatabases.dispose());
it.live(
  "claims at most one provider initiation and reconciles only exact authenticated evidence without lifecycle regression",
  () =>
    Effect.gen(function* () {
      const input = yield* prepare(yield* weeklySummaryTestDatabase);
      expect(yield* stageInsightDelivery(input)).toBe(true);
      expect((yield* startInsightSend({ ...input, userId: weeklySummaryOtherUser }))._tag).toBe(
        "NotClaimed"
      );
      const claim = yield* startInsightSend(input);
      if (claim._tag !== "Ready") {
        return yield* Effect.die("Expected ready claim");
      }
      expect((yield* startInsightSend(input))._tag).toBe("NotClaimed");
      const providerMessageId = WhatsAppProviderMessageId.make("wamid.summary");
      yield* recordInsightSend({
        ...input,
        correlationToken: claim.correlationToken,
        outcome: { kind: "accepted", providerMessageId },
      });
      const admission = {
        userId: input.userId,
        correlationToken: claim.correlationToken,
        businessPhoneNumberId: recipient.businessPhoneNumberId,
        providerMessageId,
        outcome: "delivered" as const,
        occurredAtMs: DateTime.toEpochMillis(input.now),
        receivedAtMs: DateTime.toEpochMillis(input.now),
      };
      expect(
        yield* reconcileInsightStatus({
          db: input.db,
          admission: { ...admission, userId: weeklySummaryOtherUser },
        })
      ).toEqual({ _tag: "Refused" });
      expect(
        yield* reconcileInsightStatus({
          db: input.db,
          admission: {
            ...admission,
            businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("987654321"),
          },
        })
      ).toEqual({ _tag: "Refused" });
      expect(
        yield* reconcileInsightStatus({
          db: input.db,
          admission: { ...admission, providerMessageId: WhatsAppProviderMessageId.make("wrong") },
        })
      ).toEqual({ _tag: "Refused" });
      expect(
        (yield* reconcileInsightStatus({
          db: input.db,
          admission: { ...admission, occurredAtMs: admission.occurredAtMs + 60_000 },
        }))._tag
      ).toBe("VerifiedDelivery");
      expect(
        (yield* reconcileInsightStatus({
          db: input.db,
          admission: { ...admission, outcome: "sent" },
        }))._tag
      ).toBe("VerifiedDelivery");
      expect(
        (yield* startInsightSend({ ...input, now: DateTime.add(input.expiresAt, { days: 1 }) }))
          ._tag
      ).toBe("NotClaimed");
    })
);
it.live(
  "defers to the captured-zone delivery window and refuses the exact exclusive deadline",
  () =>
    Effect.gen(function* () {
      const input = yield* prepare(yield* weeklySummaryTestDatabase);
      yield* stageInsightDelivery(input);
      const deferred = yield* startInsightSend({
        ...input,
        now: DateTime.add(input.now, { hours: 1 }),
      });
      if (deferred._tag !== "Deferred") {
        return yield* Effect.die("Expected deferred claim");
      }
      expect(DateTime.formatIso(deferred.nextEligibleAt)).toBe("2026-08-10T14:00:00.000Z");
      expect((yield* startInsightSend({ ...input, now: input.expiresAt }))._tag).toBe("Expired");
      expect(
        (yield* startInsightSend({
          ...input,
          now: DateTime.subtract(input.expiresAt, { minutes: 1 }),
        }))._tag
      ).toBe("NotClaimed");
    })
);
it.live("a staged report cannot send after explicit revocation", () =>
  Effect.gen(function* () {
    const input = yield* prepare(yield* weeklySummaryTestDatabase);
    yield* stageInsightDelivery(input);
    const context = {
      db: input.db,
      userId: input.userId,
      caller: weeklySummaryTestCaller,
      now: input.now,
    };
    const offer = Option.getOrThrow(yield* createWeeklyConsentOffer(context));
    yield* recordWeeklyConsentDisclosure({
      ...context,
      offerId: offer.id,
      disclosureMessageId: "revoke-disclosure",
    });
    yield* recordWeeklySummaryDecision({
      ...context,
      choice: offer.revokeChoice,
      decisionMessageId: "revoke",
    });
    expect((yield* startInsightSend(input))._tag).toBe("NotClaimed");
  })
);
