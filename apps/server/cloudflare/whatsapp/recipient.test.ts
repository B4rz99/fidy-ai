import { Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import {
  weeklySummaryTestCaller,
  weeklySummaryTestDatabase,
  weeklySummaryTestDatabases,
  weeklySummaryTestUser,
} from "../weekly-summary.test-fixture";
import { InsightRecipient } from "./contract";
import { findInsightRecipient, prepareInsightRecipient } from "./operations";
import { sweepExpiredWhatsAppWindows } from "./runtime";

afterAll(() => weeklySummaryTestDatabases.dispose());

it.each([true, false])(
  "retains recipient routing independently of expired service windows (recipient present: %s)",
  (present) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* weeklySummaryTestDatabase;
        const userId = weeklySummaryTestUser;
        const recipient = yield* Schema.decodeEffect(InsightRecipient)({
          portfolioId: weeklySummaryTestCaller.businessPortfolioId,
          bsuid: weeklySummaryTestCaller.businessScopedUserId,
          businessPhoneNumberId: "123456789",
        });
        yield* Effect.tryPromise(() =>
          db.batch([
            ...(present
              ? [prepareInsightRecipient({ db, userId, recipient, receivedAtMs: 17 })]
              : []),
            db
              .prepare(
                "INSERT INTO whatsapp_service_windows(user_id,portfolio_id,bsuid,last_verified_inbound_at_ms) VALUES(?,?,?,17)"
              )
              .bind(userId, recipient.portfolioId, recipient.bsuid),
          ])
        );
        yield* sweepExpiredWhatsAppWindows({ db, now: 86400018 });
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT * FROM whatsapp_service_windows WHERE user_id=?").bind(userId).all()
          )
        ).toMatchObject({ results: [] });
        expect(yield* findInsightRecipient({ db, userId })).toEqual(
          present ? Option.some(recipient) : Option.none()
        );
      })
    )
);
