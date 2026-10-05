import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { DateTime, Effect, Exit, Option, Schema } from "effect";
import {
  InsightTemplateConfiguration,
  WeeklyQuestionTemplateConfiguration,
} from "../../src/shell/channels/whatsapp/contract";
import assert from "node:assert/strict";
import { InsightUnavailable } from "./contract";
import { executeWeeklyWork } from "./runtime";
import {
  findWeeklyGovernor,
  materializeWeeklySummary,
  prepareWeeklyDeliverySettlement,
  prepareWeeklyQuestionDelivery,
} from "./operations";
import { InsightEventId } from "../../src/core/insights/contract";
import {
  activateWeeklySummary,
  weeklySummaryOtherUser,
  weeklySummaryTestDatabase,
  weeklySummaryTestDatabases,
  weeklySummaryTestNow,
  weeklySummaryTestUser,
} from "../weekly-summary.test-fixture";

afterAll(() => weeklySummaryTestDatabases.dispose());
it.live("rejects corrupt retained pause dates before materializing any report", () =>
  Effect.gen(function* () {
    const db = yield* weeklySummaryTestDatabase;
    const userId = weeklySummaryTestUser;
    const schedule = yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
    yield* Effect.tryPromise(() =>
      db
        .prepare("INSERT INTO weekly_governors(user_id,paused_at_ms) VALUES(?,?)")
        .bind(userId, 8_640_000_000_000_001)
        .run()
    );
    assert.deepStrictEqual(
      yield* Effect.exit(findWeeklyGovernor({ db, userId })),
      Exit.fail(new InsightUnavailable())
    );
    assert.deepStrictEqual(
      yield* Effect.exit(
        materializeWeeklySummary({ db, userId, id: schedule.id, now: schedule.nextScheduledAt })
      ),
      Exit.fail(new InsightUnavailable())
    );
    expect(
      (yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM insight_events WHERE user_id=?").bind(userId).all()
      )).results
    ).toEqual([]);
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT insight_event_id FROM weekly_summary_outbox WHERE user_id=?")
          .bind(userId)
          .all()
      )).results
    ).toEqual([]);
  })
);
it.live("rejects a corrupt retained question origin without staging or sending work", () =>
  Effect.gen(function* () {
    const db = yield* weeklySummaryTestDatabase;
    const userId = weeklySummaryTestUser;
    const id = "11111111-1111-4111-8111-111111111114";
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "INSERT INTO weekly_question_intents(id,user_id,origin,created_at_ms) VALUES(?,?,'requested',?)"
        )
        .bind(id, userId, 8_640_000_000_000_001)
        .run()
    );
    assert.deepStrictEqual(
      yield* Effect.exit(
        executeWeeklyWork({
          userId,
          work: { kind: "weekly-question", version: 1, userId, id },
          now: weeklySummaryTestNow,
          environment: {
            DB: db,
            KAPSO_API_KEY: "provider-test-key",
            WEEKLY_SUMMARY_ENABLED: "enabled",
            WEEKLY_SUMMARY_TEMPLATE_JSON: yield* Schema.encodeEffect(
              Schema.fromJsonString(InsightTemplateConfiguration)
            )({
              name: "fidy_weekly_summary",
              language: "es",
              approval: "approved",
              body: "Tu resumen semanal: {{1}} Consulta tus movimientos en Fidy.",
            }),
            WEEKLY_QUESTION_TEMPLATE_JSON: yield* Schema.encodeEffect(
              Schema.fromJsonString(WeeklyQuestionTemplateConfiguration)
            )({
              name: "fidy_weekly_question",
              language: "es",
              approval: "approved",
              body: "Fidy: {{1}}",
            }),
          },
        })
      ),
      Exit.fail(new InsightUnavailable())
    );
    expect(
      yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT state FROM weekly_question_intents WHERE user_id=? AND id=?")
          .bind(userId, id)
          .first()
      )
    ).toEqual({ state: "ready" });
    expect(
      (yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM weekly_governor_questions WHERE user_id=?").bind(userId).all()
      )).results
    ).toEqual([]);
  })
);
it.live(
  "a re-enabled User with permanent no history continues past the threshold without another question or unverified pause",
  () =>
    Effect.gen(function* () {
      const db = yield* weeklySummaryTestDatabase;
      const userId = weeklySummaryTestUser;
      yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO weekly_consent_rejections(id,user_id,offer_id,decision_message_id,decision) SELECT 'no-history',user_id,id,'no-history-message','decline' FROM weekly_consent_offers WHERE user_id=? AND decision='accept'"
          )
          .bind(userId)
          .run()
      );
      for (let index = 1; index <= 7; index++) {
        const id = InsightEventId.make(
          `35000000-0000-4000-8000-${String(index).padStart(12, "0")}`
        );
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json) VALUES(?,?,'weekly-summary','40000000-0000-4000-8000-000000000001',1,'CO','es-CO','America/Bogota',?,'[]')"
            )
            .bind(id, userId, DateTime.formatIso(DateTime.makeUnsafe(index * 1000)))
            .run()
        );
        const statements = prepareWeeklyDeliverySettlement({
          db,
          userId,
          insightEventId: id,
          thresholds: { askAfter: 4, pauseAfter: 2 },
          proof: {
            sql: "SELECT ? AS user_id,? AS insight_event_id,? AS provider_message_id,? AS send_started_at_ms,? AS delivered_at_ms",
            params: [userId, id, `delivered-${index}`, index * 1000, index * 1000],
          },
        });
        yield* Effect.tryPromise(() => db.batch([...statements]));
        expect(Option.getOrThrow(yield* findWeeklyGovernor({ db, userId }))).toEqual({
          _tag: "Attentive",
          unanswered: index,
        });
      }
      const questions = yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM weekly_question_intents WHERE user_id=?").bind(userId).all()
      );
      expect(questions.results).toEqual([]);
    })
);
it.live("counts verified scheduled deliveries once, asks at four and pauses after two more", () =>
  Effect.gen(function* () {
    const db = yield* weeklySummaryTestDatabase;
    const userId = weeklySummaryTestUser;
    for (let index = 1; index <= 6; index++) {
      const id = InsightEventId.make(`30000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json) VALUES(?,?,'weekly-summary','40000000-0000-4000-8000-000000000001',1,'CO','es-CO','America/Bogota',?,'[]')"
          )
          .bind(id, userId, DateTime.formatIso(DateTime.makeUnsafe(index * 1000)))
          .run()
      );
      const input = {
        db,
        userId,
        insightEventId: id,
        thresholds: { askAfter: 4, pauseAfter: 2 },
        proof: {
          sql: "SELECT ? AS user_id,? AS insight_event_id,? AS provider_message_id,? AS send_started_at_ms,? AS delivered_at_ms",
          params: [userId, id, `provider-${index}`, index * 1000, index * 1000],
        },
      };
      yield* Effect.tryPromise(() => db.batch([...prepareWeeklyDeliverySettlement(input)]));
      yield* Effect.tryPromise(() => db.batch([...prepareWeeklyDeliverySettlement(input)]));
      const state = Option.getOrThrow(yield* findWeeklyGovernor({ db, userId }));
      expect(state.unanswered).toBe(index);
      const expectedStates = [
        "Attentive",
        "Attentive",
        "Attentive",
        "QuestionPending",
        "QuestionDelivered",
        "Paused",
      ];
      expect(state._tag).toBe(expectedStates[index - 1]);
      if (index === 4) {
        yield* Effect.tryPromise(() =>
          prepareWeeklyQuestionDelivery({
            db,
            userId,
            proof: {
              sql: "SELECT ? AS user_id,? AS question_id,4001 AS send_started_at_ms,4001 AS delivered_at_ms",
              params: [userId, id],
            },
          }).run()
        );
      }
    }
    expect(Option.isNone(yield* findWeeklyGovernor({ db, userId: weeklySummaryOtherUser }))).toBe(
      true
    );
  })
);
