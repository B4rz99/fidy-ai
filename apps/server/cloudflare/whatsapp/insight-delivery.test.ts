import { afterAll } from "vitest";
import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Exit, Option, Schema } from "effect";
import assert from "node:assert/strict";
import { makeInsightTemplateSender } from "../../src/shell/channels/whatsapp/runtime";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import {
  createWeeklyGovernorConsentOffer,
  recordWeeklyConsentDisclosure,
} from "../consent/operations";
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
import { InsightRecipient, type InsightWhatsAppStage, WhatsAppUnavailable } from "./contract";
import {
  readInsightDeliveryEvidence,
  reconcileInsightStatus,
  recordInsightSend,
  stageInsightDelivery,
  startInsightSend,
  startWeeklyQuestion,
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
  "rejects corrupt retained verified-delivery timestamps through the closed channel failure",
  () =>
    Effect.gen(function* () {
      const input = yield* prepare(yield* weeklySummaryTestDatabase);
      yield* Effect.tryPromise(() =>
        input.db
          .prepare(`INSERT INTO insight_whatsapp_claims
      (user_id,insight_event_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,
       summary_json,text,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms)
      VALUES (?,?,?,?,?,?,NULL,NULL,?,?,?,'delivered',?,'wamid.corrupt',?)`)
          .bind(
            input.userId,
            input.insightEventId,
            "11111111-1111-4111-8111-111111111111",
            recipient.portfolioId,
            recipient.bsuid,
            recipient.businessPhoneNumberId,
            input.scheduledAt.epochMilliseconds,
            input.expiresAt.epochMilliseconds,
            input.timeZone,
            8_640_000_000_000_001,
            8_640_000_000_000_001
          )
          .run()
      );
      const result = yield* Effect.exit(
        readInsightDeliveryEvidence({
          db: input.db,
          userId: input.userId,
          insightEventId: input.insightEventId,
          now: input.now.epochMilliseconds,
        })
      );
      assert.deepStrictEqual(result, Exit.fail(new WhatsAppUnavailable()));
    })
);
it.live("refuses corrupt staged claim dates without consuming send authority", () =>
  Effect.gen(function* () {
    const input = yield* prepare(yield* weeklySummaryTestDatabase);
    yield* stageInsightDelivery(input);
    // Inject retained corruption without weakening the production write fence.
    yield* Effect.tryPromise(() => input.db.exec("DROP TRIGGER insight_whatsapp_claim_identity"));
    for (const scheduledAt of [-8_640_000_000_000_001, 8_640_000_000_000_000]) {
      yield* Effect.tryPromise(() =>
        input.db
          .prepare(
            "UPDATE insight_whatsapp_claims SET scheduled_at_ms=?,expires_at_ms=? WHERE user_id=? AND insight_event_id=?"
          )
          .bind(scheduledAt, scheduledAt + 1, input.userId, input.insightEventId)
          .run()
      );
      assert.deepStrictEqual(
        yield* Effect.exit(startInsightSend(input)),
        Exit.fail(new WhatsAppUnavailable())
      );
      expect(
        yield* Effect.tryPromise(() =>
          input.db
            .prepare(
              "SELECT state,send_started_at_ms FROM insight_whatsapp_claims WHERE user_id=? AND insight_event_id=?"
            )
            .bind(input.userId, input.insightEventId)
            .first()
        )
      ).toEqual({ state: "staged", send_started_at_ms: null });
      yield* Effect.tryPromise(() =>
        input.db
          .prepare(
            "UPDATE insight_whatsapp_claims SET scheduled_at_ms=?,expires_at_ms=? WHERE user_id=? AND insight_event_id=?"
          )
          .bind(
            DateTime.toEpochMillis(input.scheduledAt),
            DateTime.toEpochMillis(input.expiresAt),
            input.userId,
            input.insightEventId
          )
          .run()
      );
    }
    expect((yield* startInsightSend(input))._tag).toBe("Ready");
  })
);
it.live("refuses corrupt weekly question dates before consuming send authority", () =>
  Effect.gen(function* () {
    const input = yield* prepare(yield* weeklySummaryTestDatabase);
    const id = "11111111-1111-4111-8111-111111111112";
    yield* Effect.tryPromise(() =>
      input.db
        .prepare(`INSERT INTO weekly_governor_questions
        (id,user_id,offer_id,created_at_ms,expires_at_ms,correlation_token,portfolio_id,bsuid,business_phone_number_id,time_zone)
        SELECT ?,user_id,id,?,?,?, ?,?,?,? FROM weekly_consent_offers WHERE user_id=? LIMIT 1`)
        .bind(
          id,
          8_640_000_000_000_000,
          8_640_000_000_000_001,
          "11111111-1111-4111-8111-111111111113",
          recipient.portfolioId,
          recipient.bsuid,
          recipient.businessPhoneNumberId,
          input.timeZone,
          input.userId
        )
        .run()
    );
    const claim = {
      db: input.db,
      userId: input.userId,
      id,
      now: input.now,
      guard: { sql: "SELECT 1", params: [] },
    };
    for (const createdAt of [8_640_000_000_000_000, -8_640_000_000_000_001]) {
      yield* Effect.tryPromise(() =>
        input.db
          .prepare(
            "UPDATE weekly_governor_questions SET created_at_ms=?,expires_at_ms=? WHERE user_id=? AND id=?"
          )
          .bind(createdAt, createdAt + 1, input.userId, id)
          .run()
      );
      assert.deepStrictEqual(
        yield* Effect.exit(startWeeklyQuestion(claim)),
        Exit.fail(new WhatsAppUnavailable())
      );
      expect(
        yield* Effect.tryPromise(() =>
          input.db
            .prepare(
              "SELECT state,send_started_at_ms FROM weekly_governor_questions WHERE user_id=? AND id=?"
            )
            .bind(input.userId, id)
            .first()
        )
      ).toEqual({ state: "ready", send_started_at_ms: null });
    }
  })
);
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
    const offer = Option.getOrThrow(
      yield* createWeeklyGovernorConsentOffer({
        ...context,
        request: { _tag: "ShortOffer", origin: "proactive" },
      })
    );
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
