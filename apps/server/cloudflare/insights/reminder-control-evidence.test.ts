import { Effect, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import {
  activateTestReminder,
  proactivityDatabase,
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
