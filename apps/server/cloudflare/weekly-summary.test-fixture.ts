import { DateTime, Effect, Option, Schema } from "effect";
import { DisclosureSnapshot } from "../src/core/consent/contract";
import { UserId, WhatsAppCallerReference } from "../src/core/identity/contract";
import { currentDisclosureFor } from "../src/shell/consent/operations";
import { createWeeklyConsentOffer, recordWeeklyConsentDisclosure } from "./consent/operations";
import {
  findWeeklySchedule,
  generateInsight,
  recordWeeklySummaryDecision,
} from "./insights/operations";
import { type WeeklyScheduleSnapshot } from "./insights/contract";
import { type InsightEventId, InsightGenerationInput } from "../src/core/insights/contract";
import { categoryIds } from "../src/core/categories/contract";
import { installTestSchema, isolatedTestDatabases } from "./d1-test-fixture";

/** Broad native WeeklySummary integration harness; seeds qualified Users, never substitutes owner persistence. */
export const weeklySummaryTestDatabases = isolatedTestDatabases();
export const weeklySummaryTestUser = UserId.make("10000000-0000-4000-8000-000000000051");
export const weeklySummaryOtherUser = UserId.make("10000000-0000-4000-8000-000000000052");
export const weeklySummaryTestCaller = Schema.decodeSync(WhatsAppCallerReference)({
  businessPortfolioId: "portfolio",
  businessScopedUserId: "CO.abcdef",
});
export const weeklySummaryTestNow = DateTime.makeUnsafe("2026-08-09T12:00:00Z");
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
export const weeklySummaryDatabaseAt = (now: DateTime.Utc): Effect.Effect<D1Database> =>
  Effect.gen(function* () {
    const db = yield* attempt(() => weeklySummaryTestDatabases.acquire());
    const names = Array.from(
      new Bun.Glob("*.sql").scanSync(new URL("./migrations/", import.meta.url).pathname)
    ).sort();
    yield* attempt(() =>
      installTestSchema({
        db,
        sources: names.map((name) => new URL(`./migrations/${name}`, import.meta.url)),
      })
    );
    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot))
    )(currentDisclosureFor()).pipe(Effect.orDie);
    for (const id of [weeklySummaryTestUser, weeklySummaryOtherUser]) {
      yield* attempt(() =>
        db
          .prepare(
            "INSERT INTO users (id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
          )
          .bind(id, now.epochMilliseconds)
          .run()
      );
      yield* attempt(() =>
        db
          .prepare(
            "INSERT INTO onboarding_consent_records (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES (?,?,?,'disclosed','accepted',?,?)"
          )
          .bind(id, id, json, 0, 0)
          .run()
      );
    }
    yield* attempt(() =>
      db
        .prepare(
          "INSERT INTO whatsapp_identities (user_id,portfolio_id,bsuid,verified_at_ms) VALUES (?,?,?,?)"
        )
        .bind(
          weeklySummaryTestUser,
          weeklySummaryTestCaller.businessPortfolioId,
          weeklySummaryTestCaller.businessScopedUserId,
          now.epochMilliseconds
        )
        .run()
    );
    return db;
  });

export const weeklySummaryTestDatabase: Effect.Effect<D1Database> =
  weeklySummaryDatabaseAt(weeklySummaryTestNow);

/** Set up actual authenticated explicit opt-in through the production owners. */
export const activateWeeklySummary = ({
  db,
  now,
}: Readonly<{ db: D1Database; now: DateTime.Utc }>): Effect.Effect<WeeklyScheduleSnapshot> =>
  Effect.gen(function* () {
    const context = {
      db,
      userId: weeklySummaryTestUser,
      caller: weeklySummaryTestCaller,
      now,
    };
    const offer = Option.getOrThrow(yield* createWeeklyConsentOffer(context));
    yield* recordWeeklyConsentDisclosure({
      ...context,
      offerId: offer.id,
      disclosureMessageId: "weekly-disclosure",
    });
    yield* recordWeeklySummaryDecision({
      ...context,
      choice: offer.acceptChoice,
      decisionMessageId: "weekly-accept",
    });
    return Option.getOrThrow(yield* findWeeklySchedule(context));
  }).pipe(Effect.orDie);
/** Broad fixture input: actual effective transaction, not a replacement projection or report store. */
export const seedWeeklySummaryActivity = ({
  db,
  at,
}: Readonly<{ db: D1Database; at: string }>): Effect.Effect<void> =>
  Effect.tryPromise(() =>
    db
      .prepare(
        "INSERT INTO transactions(id,user_id,amount,currency,category_id,direction,occurred_at,created_at,counterparty) VALUES (?,?, '10.25','COP',?,'outflow',?,?,NULL)"
      )
      .bind(
        "20000000-0000-4000-8000-000000000001",
        weeklySummaryTestUser,
        categoryIds.mercado,
        at,
        at
      )
      .run()
  ).pipe(Effect.asVoid, Effect.orDie);

/** Broad external-evidence fixture: another User reports the same opaque provider id for their own event. */
export const seedForeignProviderEvidence = (db: D1Database): Effect.Effect<void> =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeEffect(Schema.toCodecJson(InsightGenerationInput))({
      kind: "manual-entry-reminder",
      scheduleId: "30000000-0000-4000-8000-000000000001",
      scheduleVersion: 1,
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: "America/Bogota",
      scheduledAt: DateTime.formatIso(weeklySummaryTestNow),
      moneyGroups: [],
    });
    const event = Option.getOrThrow(
      yield* generateInsight({ db, userId: weeklySummaryOtherUser, input })
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "INSERT INTO insight_delivery_attempts(id,user_id,insight_event_id,sent_at,channel,provider,provider_message_id) VALUES(?,?,?,?,'whatsapp','kapso','wamid.proactive')"
        )
        .bind(
          "30000000-0000-4000-8000-000000000002",
          weeklySummaryOtherUser,
          event.id,
          DateTime.formatIso(weeklySummaryTestNow)
        )
        .run()
    );
  }).pipe(Effect.orDie);

/** Broad fixture attention state; production mutations remain in the Insights owner. */
export const setWeeklySummaryAttention = (
  input: Readonly<{ db: D1Database; id: InsightEventId; state: "read" | "dismissed" }>
): Effect.Effect<void> =>
  Effect.tryPromise(() =>
    input.db
      .prepare("UPDATE insight_events SET lifecycle_state=? WHERE user_id=? AND id=?")
      .bind(input.state, weeklySummaryTestUser, input.id)
      .run()
  ).pipe(Effect.asVoid, Effect.orDie);
