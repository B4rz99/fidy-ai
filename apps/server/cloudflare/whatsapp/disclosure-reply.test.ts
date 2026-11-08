import { TranscriptText } from "../../src/core/agent/contract";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import { afterAll, expect, it } from "vitest";
import { Effect, Option, Schema } from "effect";
import {
  proactivityDatabase,
  proactivityTestCallers,
  proactivityTestDatabases,
  proactivityTestUsers,
} from "../proactivity.test-fixture";
import { WhatsAppTurnAdmission } from "./contract";
import { readDisclosureReplyChoice } from "./operations";

afterAll(() => proactivityTestDatabases.dispose());
const id = "70000000-0000-4000-8000-000000000001";
const now = 1_800_000_000_000;
it("binds ordinary disclosure replies to the delivered message, same User, association and business endpoint", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const caller = proactivityTestCallers[0];
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            `INSERT INTO whatsapp_deliveries(kind,user_id,delivery_id,role,correlation_token,portfolio_id,bsuid,business_phone_number_id,text,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,delivered_at_ms,provider_message_id) VALUES ('proactivity',?,?,'budget-offer',?,?,?,?, '¿Quieres activar los avisos?',?,?,'America/Bogota','delivered',?,?,'wamid.offer')`
          )
          .bind(
            proactivityTestUsers[0],
            id,
            id,
            caller.businessPortfolioId,
            caller.businessScopedUserId,
            "123456789",
            now - 1000,
            now + 600000,
            now - 1000,
            now - 500
          )
          .run()
      );
      const proof = yield* Schema.decodeEffect(WhatsAppTurnAdmission)({
        userId: proactivityTestUsers[0],
        portfolioId: caller.businessPortfolioId,
        bsuid: caller.businessScopedUserId,
        businessPhoneNumberId: "123456789",
        messageId: "wamid.yes",
        occurredAtMs: now,
        receivedAtMs: now,
        text: "Sí",
        replyToMessageId: "wamid.offer",
      });
      expect(yield* readDisclosureReplyChoice({ db, proof, now })).toEqual(
        Option.some(`p:budget-threshold:${id}:accept`)
      );
      expect(
        yield* readDisclosureReplyChoice({
          db,
          proof: { ...proof, text: TranscriptText.make("No") },
          now,
        })
      ).toEqual(Option.some(`p:budget-threshold:${id}:decline`));
      expect(
        yield* readDisclosureReplyChoice({
          db,
          proof: { ...proof, text: TranscriptText.make("Desactivar") },
          now,
        })
      ).toEqual(Option.some(`p:budget-threshold:${id}:revoke`));
      for (const wrong of [
        { ...proof, replyToMessageId: Option.none() },
        { ...proof, replyToMessageId: Option.some(WhatsAppProviderMessageId.make("wamid.other")) },
        { ...proof, userId: proactivityTestUsers[1] },
        { ...proof, bsuid: proactivityTestCallers[1].businessScopedUserId },
        { ...proof, businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("987654321") },
        { ...proof, text: TranscriptText.make("Está bien") },
      ]) {
        expect(yield* readDisclosureReplyChoice({ db, proof: wrong, now })).toEqual(Option.none());
      }
      expect(yield* readDisclosureReplyChoice({ db, proof, now: now + 600001 })).toEqual(
        Option.none()
      );
    })
  ));
