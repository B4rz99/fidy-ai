import { WhatsAppTurnAdmission } from "../whatsapp/contract";
import { findReminderGovernor, prepareReminderDelivery, prepareReminderReply } from "./operations";
import { Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import {
  activateTestReminder,
  proactivityDatabase,
  proactivityTestCallers,
  proactivityTestDatabases,
  proactivityTestUsers,
} from "../proactivity.test-fixture";
import { findProactivityConsentGrant } from "../consent/operations";

afterAll(() => proactivityTestDatabases.dispose());

it("keeps a reminder control decision immutable after its message content expires", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const userId = proactivityTestUsers[0];
      yield* activateTestReminder(db);
      const grant = Option.getOrThrow(
        yield* findProactivityConsentGrant({ db, userId, kind: "manual-entry-reminder" })
      );
      const id = "14730000-0000-4000-8000-000000000001";
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO proactive_messages(kind,id,user_id,role,consent_grant_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,control_message_id,control_choice) VALUES('proactivity-delivery',?,?,'reminder-question',?,'Question',0,86400000,'America/Bogota',0,'original-reply',?)"
          )
          .bind(id, userId, grant.id, `reminder:${id}:stop`)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE proactive_messages SET text=NULL WHERE user_id=? AND id=?")
          .bind(userId, id)
          .run()
      );
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare("UPDATE proactive_messages SET control_choice=? WHERE user_id=? AND id=?")
            .bind(`reminder:${id}:continue`, userId, id)
            .run()
        ).rejects.toThrow("reminder_control_immutable")
      );
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT text,control_message_id,control_choice FROM proactive_messages WHERE user_id=? AND id=?"
            )
            .bind(userId, id)
            .first()
        )
      ).toEqual({
        text: null,
        control_message_id: "original-reply",
        control_choice: `reminder:${id}:stop`,
      });
    })
  ));

it.each([
  {
    name: "old-question",
    capturedGrant: "current",
    role: "reminder-question",
    id: "old-question",
    deliveredAt: 200,
    answers: false,
  },
  {
    name: "replaced-grant",
    capturedGrant: "replaced",
    role: "reminder-question",
    id: "current-question",
    deliveredAt: 200,
    answers: false,
  },
  {
    name: "old-episode",
    capturedGrant: "current",
    role: "manual-entry-reminder",
    id: "reminder",
    deliveredAt: 50,
    answers: false,
  },
  {
    name: "current-question",
    capturedGrant: "current",
    role: "reminder-question",
    id: "current-question",
    deliveredAt: 200,
    answers: true,
  },
  {
    name: "current-reminder",
    capturedGrant: "current",
    role: "manual-entry-reminder",
    id: "reminder",
    deliveredAt: 200,
    answers: true,
  },
] as const)(
  "reminder reply correlates $name to its current episode and captured grant",
  ({ name, capturedGrant, role, id, deliveredAt, answers }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* proactivityDatabase;
        const userId = proactivityTestUsers[0];
        yield* activateTestReminder(db);
        const grant = Option.getOrThrow(
          yield* findProactivityConsentGrant({ db, userId, kind: "manual-entry-reminder" })
        );
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "UPDATE reminder_proactivity_state SET standing_json=json_object('_tag','QuestionDelivered','unanswered',4),last_reply_at_ms=100,question_id='current-question',question_delivered_at_ms=150 WHERE user_id=?"
            )
            .bind(userId)
            .run()
        );
        const caller = proactivityTestCallers[0];
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO whatsapp_deliveries(kind,user_id,delivery_id,role,consent_grant_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms) VALUES('proactivity',?,?,?,?,?,?,?,?,0,86400000,'America/Bogota','delivered',1,'reply-provider',?)"
            )
            .bind(
              userId,
              id,
              role,
              capturedGrant === "current" ? grant.id : "replaced-grant",
              name,
              caller.businessPortfolioId,
              caller.businessScopedUserId,
              "123456789",
              deliveredAt
            )
            .run()
        );
        const proof = Schema.decodeSync(WhatsAppTurnAdmission)({
          userId,
          portfolioId: caller.businessPortfolioId,
          bsuid: caller.businessScopedUserId,
          businessPhoneNumberId: "123456789",
          messageId: `reply-${name}`,
          text: "gracias",
          occurredAtMs: 300,
          receivedAtMs: 300,
          replyToMessageId: "reply-provider",
        });
        yield* Effect.tryPromise(() => prepareReminderReply({ db, userId, proof }).run());
        expect(Option.getOrThrow(yield* findReminderGovernor({ db, userId }))).toEqual(
          answers
            ? { _tag: "Attentive", unanswered: 0 }
            : { _tag: "QuestionDelivered", unanswered: 4 }
        );
      })
    )
);

it("late reminder question delivery cannot advance a replaced captured grant", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const userId = proactivityTestUsers[0];
      yield* activateTestReminder(db);
      const grant = Option.getOrThrow(
        yield* findProactivityConsentGrant({ db, userId, kind: "manual-entry-reminder" })
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE reminder_proactivity_state SET standing_json=json_object('_tag','QuestionPending','unanswered',3),last_reply_at_ms=100,question_id='question' WHERE user_id=?"
          )
          .bind(userId)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO proactive_messages(kind,id,user_id,role,consent_grant_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) VALUES('proactivity-delivery','question',?,'reminder-question',?,'Question',0,86400000,'America/Bogota',0)"
          )
          .bind(userId, grant.id)
          .run()
      );
      const caller = proactivityTestCallers[0];
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO whatsapp_deliveries(kind,user_id,delivery_id,role,consent_grant_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms) VALUES('proactivity',?,'question','reminder-question','replaced-grant','late-question',?,?,'123456789',0,86400000,'America/Bogota','delivered',1,'question-provider',200)"
          )
          .bind(userId, caller.businessPortfolioId, caller.businessScopedUserId)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db.batch([...prepareReminderDelivery({ db, userId, id: "question" })])
      );
      expect(Option.getOrThrow(yield* findReminderGovernor({ db, userId }))).toEqual({
        _tag: "QuestionPending",
        unanswered: 3,
      });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT reminder_governor_counted FROM proactive_messages WHERE user_id=? AND id='question'"
            )
            .bind(userId)
            .first()
        )
      ).toEqual({ reminder_governor_counted: null });
    })
  ));
