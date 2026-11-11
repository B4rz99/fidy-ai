import { WhatsAppTurnAdmission } from "../whatsapp/contract";
import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import {
  InsightTemplateConfiguration,
  WeeklyQuestionTemplateConfiguration,
} from "../../src/shell/channels/whatsapp/contract";
import assert from "node:assert/strict";
import { InsightUnavailable } from "./contract";
import { executeProactivityWork } from "./runtime";
import {
  findWeeklyGovernor,
  materializeWeeklySummary,
  prepareWeeklyDeliverySettlement,
  prepareWeeklyGovernorReply,
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

const assertTypedFailure = <E>(exit: Exit.Exit<unknown, E>, expected: E): void => {
  assert(Exit.isFailure(exit));
  assert.equal(exit.cause.reasons.length, 1);
  const reason = exit.cause.reasons[0];
  assert(reason !== undefined && Cause.isFailReason(reason));
  assert.deepStrictEqual(reason.error, expected);
};

const seedGovernorQuestion = (
  db: D1Database,
  id: string,
  at: number
): Effect.Effect<unknown, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db
      .prepare(
        "INSERT INTO whatsapp_deliveries(kind,id,user_id,offer_id,consent_grant_id,created_at_ms,expires_at_ms,correlation_token,portfolio_id,bsuid,business_phone_number_id,time_zone,state,provider_message_id,delivered_at_ms,send_started_at_ms) SELECT 'weekly-question',?,user_id,id,(SELECT consent_grant_id FROM schedules WHERE kind='weekly' AND user_id=?),0,600000,?,'portfolio','CO.abcdef','123456789','America/Bogota','delivered',?,?,? FROM consent_offers WHERE kind='weekly-summary' AND user_id=? LIMIT 1"
      )
      .bind(id, weeklySummaryTestUser, id, `question-${id}`, at, at, weeklySummaryTestUser)
      .run()
  );
const seedGovernorDelivery = (
  db: D1Database,
  id: InsightEventId,
  at: number
): Effect.Effect<unknown, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(
          "INSERT INTO insight_reports(user_id,insight_event_id,kind,consent_grant_id,payload_json,presentation_json,content_expires_at_ms) SELECT user_id,?,'weekly-summary',consent_grant_id,'{}','{}',86400000 FROM schedules WHERE kind='weekly' AND user_id=?"
        )
        .bind(id, weeklySummaryTestUser),
      db
        .prepare(
          "INSERT INTO proactive_messages(kind,id,user_id,role,report_event_id,consent_grant_id,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) SELECT 'weekly-summary',?,user_id,'weekly-summary',?,consent_grant_id,?,?,'America/Bogota',? FROM schedules WHERE kind='weekly' AND user_id=?"
        )
        .bind(id, id, at, at + 86400000, at, weeklySummaryTestUser),
      db
        .prepare(
          "INSERT INTO whatsapp_deliveries(kind,user_id,insight_event_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms) VALUES('insight',?,?,?,'portfolio','CO.abcdef','123456789',?,?,'America/Bogota','delivered',?,?,?)"
        )
        .bind(weeklySummaryTestUser, id, id, at, at + 86400000, at, `provider-${id}`, at),
    ])
  );

afterAll(() => weeklySummaryTestDatabases.dispose());
it.live("rejects corrupt retained pause dates before materializing any report", () =>
  Effect.gen(function* () {
    const db = yield* weeklySummaryTestDatabase;
    const userId = weeklySummaryTestUser;
    const schedule = yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "INSERT INTO weekly_proactivity_state AS weekly_governors(user_id,paused_at_ms) VALUES (?,?)"
        )
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
          .prepare(
            "SELECT delivery_id AS insight_event_id FROM (SELECT rowid,user_id,kind,id AS delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts FROM proactive_messages WHERE dispatch_state IS NOT NULL) AS proactivity_delivery_outbox WHERE kind='weekly-summary' AND user_id=?"
          )
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
          "INSERT INTO weekly_question_requests(id,user_id,origin,created_at_ms,state,last_attempt_at_ms,restart_attempts) VALUES(?,?,'requested',?,'ready',0,0)"
        )
        .bind(id, userId, 8_640_000_000_000_001)
        .run()
    );
    assertTypedFailure(
      yield* Effect.exit(
        executeProactivityWork({
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
              body: "Fidy te avisa: {{1}} Más en Fidy.",
            }),
          },
        })
      ),
      new InsightUnavailable()
    );
    expect(
      yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT state FROM weekly_question_requests WHERE user_id=? AND id=?")
          .bind(userId, id)
          .first()
      )
    ).toEqual({ state: "ready" });
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT id FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='weekly-question') AS weekly_governor_questions WHERE user_id=?"
          )
          .bind(userId)
          .all()
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
            "INSERT INTO consent_history (record_type,id,user_id,offer_id,decision_message_id,decision) SELECT 'weekly_rejection','no-history',user_id,id,'no-history-message','decline' FROM (SELECT rowid,* FROM consent_offers WHERE kind='weekly-summary') AS weekly_consent_offers WHERE user_id=? AND decision='accept'"
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
              "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at_ms,money_groups_json) VALUES(?,?,'weekly-summary','40000000-0000-4000-8000-000000000001',1,'CO','es-CO','America/Bogota',?,'[]')"
            )
            .bind(id, userId, index * 1000)
            .run()
        );
        yield* seedGovernorDelivery(db, id, index * 1000);
        const statements = prepareWeeklyDeliverySettlement({
          db,
          userId,
          insightEventId: id,
          thresholds: { askAfter: 4, pauseAfter: 2 },
        });
        yield* Effect.tryPromise(() => db.batch([...statements]));
        expect(Option.getOrThrow(yield* findWeeklyGovernor({ db, userId }))).toEqual({
          _tag: "Attentive",
          unanswered: index,
        });
      }
      const questions = yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM weekly_question_requests WHERE user_id=?").bind(userId).all()
      );
      expect(questions.results).toEqual([]);
    })
);
it.live("counts verified scheduled deliveries once, asks at four and pauses after two more", () =>
  Effect.gen(function* () {
    const db = yield* weeklySummaryTestDatabase;
    const userId = weeklySummaryTestUser;
    yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
    for (let index = 1; index <= 6; index++) {
      const id = InsightEventId.make(`30000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at_ms,money_groups_json) VALUES(?,?,'weekly-summary','40000000-0000-4000-8000-000000000001',1,'CO','es-CO','America/Bogota',?,'[]')"
          )
          .bind(id, userId, index * 1000)
          .run()
      );
      yield* seedGovernorDelivery(db, id, index * 1000);
      const input = {
        db,
        userId,
        insightEventId: id,
        thresholds: { askAfter: 4, pauseAfter: 2 },
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
        yield* seedGovernorQuestion(db, id, 4001);
        yield* Effect.tryPromise(() =>
          prepareWeeklyQuestionDelivery({
            db,
            userId,
            id,
          }).run()
        );
      }
    }
    expect(Option.isNone(yield* findWeeklyGovernor({ db, userId: weeklySummaryOtherUser }))).toBe(
      true
    );
  })
);

it.live(
  "an old question reply with a newer timestamp cannot answer the current weekly episode",
  () =>
    Effect.gen(function* () {
      const db = yield* weeklySummaryTestDatabase;
      const userId = weeklySummaryTestUser;
      yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO weekly_proactivity_state(user_id,unanswered,last_reply_at_ms,question_needed,question_event_id) VALUES (?,4,100,1,'current-question')"
          )
          .bind(userId)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO whatsapp_deliveries(kind,id,user_id,offer_id,consent_grant_id,created_at_ms,expires_at_ms,correlation_token,portfolio_id,bsuid,business_phone_number_id,time_zone,state,provider_message_id,delivered_at_ms,send_started_at_ms) SELECT 'weekly-question','old-question',user_id,id,(SELECT consent_grant_id FROM schedules WHERE kind='weekly' AND user_id=?),0,600000,'old-correlation','portfolio','CO.abcdef','123456789','America/Bogota','delivered','old-provider',150,150 FROM consent_offers WHERE kind='weekly-summary' AND user_id=? LIMIT 1"
          )
          .bind(userId, userId)
          .run()
      );
      const proof = Schema.decodeSync(WhatsAppTurnAdmission)({
        userId,
        portfolioId: "portfolio",
        bsuid: "CO.abcdef",
        businessPhoneNumberId: "123456789",
        messageId: "late-reply",
        text: "gracias",
        occurredAtMs: 200,
        receivedAtMs: 200,
        replyToMessageId: "old-provider",
      });
      yield* Effect.tryPromise(() => prepareWeeklyGovernorReply({ db, userId, proof }).run());
      expect(Option.getOrThrow(yield* findWeeklyGovernor({ db, userId }))).toEqual({
        _tag: "QuestionPending",
        unanswered: 4,
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE weekly_proactivity_state SET question_event_id='old-question' WHERE user_id=?"
          )
          .bind(userId)
          .run()
      );
      yield* Effect.tryPromise(() =>
        prepareWeeklyGovernorReply({
          db,
          userId,
          proof: Schema.decodeSync(WhatsAppTurnAdmission)({
            ...Schema.encodeSync(WhatsAppTurnAdmission)(proof),
            messageId: "current-reply",
            replyToMessageId: "old-provider",
          }),
        }).run()
      );
      expect(Option.getOrThrow(yield* findWeeklyGovernor({ db, userId }))).toEqual({
        _tag: "Attentive",
        unanswered: 0,
      });
    })
);

it.live("late weekly question status cannot advance a replaced captured grant", () =>
  Effect.gen(function* () {
    const db = yield* weeklySummaryTestDatabase;
    const userId = weeklySummaryTestUser;
    yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
    yield* seedGovernorQuestion(db, "question", 200);
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "UPDATE whatsapp_deliveries SET consent_grant_id='replaced-grant' WHERE kind='weekly-question' AND user_id=?"
        )
        .bind(userId)
        .run()
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "INSERT INTO weekly_proactivity_state(user_id,unanswered,last_reply_at_ms,question_needed,question_event_id) VALUES (?,4,100,1,'question')"
        )
        .bind(userId)
        .run()
    );
    yield* Effect.tryPromise(() =>
      prepareWeeklyQuestionDelivery({ db, userId, id: "question" }).run()
    );
    expect(Option.getOrThrow(yield* findWeeklyGovernor({ db, userId }))).toEqual({
      _tag: "QuestionPending",
      unanswered: 4,
    });
  })
);
