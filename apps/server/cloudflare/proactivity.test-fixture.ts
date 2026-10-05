import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import { DisclosureSnapshot } from "../src/core/consent/contract";
import { UserId, WhatsAppCallerReference } from "../src/core/identity/contract";
import { currentDisclosureFor } from "../src/shell/consent/operations";
import type { ConsentUnavailable } from "./consent/contract";
import type { InsightUnavailable } from "./insights/contract";
import type { ReminderSchedule } from "../src/core/insights/contract";
import {
  createProactivityConsentOffer,
  recordProactivityConsentDisclosure,
} from "./consent/operations";
import { findReminderSchedule, recordProactivityDecision } from "./insights/operations";
import { installTestSchema, isolatedTestDatabases } from "./d1-test-fixture";

/** Broad native proactivity integration fixture: real D1 schema and established identities, never substituted owner persistence. Each call acquires an independent database. */
export const proactivityTestDatabases = isolatedTestDatabases();
export const proactivityTestUsers = [
  UserId.make("10000000-0000-4000-8000-000000000051"),
  UserId.make("10000000-0000-4000-8000-000000000052"),
] as const;
const caller = (id: string): WhatsAppCallerReference =>
  Schema.decodeSync(WhatsAppCallerReference)({
    businessPortfolioId: "portfolio",
    businessScopedUserId: id,
  });
export const proactivityTestCallers = [caller("CO.abcdef"), caller("CO.ghijkl")] as const;
export const proactivityTestNow = DateTime.makeUnsafe("2026-10-05T23:00:00Z");
/** Activate through real qualified disclosure and atomic owner operations for native schedule tests. */
export const activateTestReminder = (
  db: D1Database
): Effect.Effect<ReminderSchedule, ConsentUnavailable | InsightUnavailable> =>
  Effect.gen(function* () {
    const context = {
      db,
      userId: proactivityTestUsers[0],
      caller: proactivityTestCallers[0],
      kind: "manual-entry-reminder" as const,
      now: proactivityTestNow,
    };
    const offer = Option.getOrThrow(yield* createProactivityConsentOffer(context));
    yield* recordProactivityConsentDisclosure({
      ...context,
      offerId: offer.id,
      disclosureMessageId: "reminder-disclosed",
    });
    yield* recordProactivityDecision({
      ...context,
      choice: offer.acceptChoice,
      decisionMessageId: "reminder-accepted",
    });
    return Option.getOrThrow(yield* findReminderSchedule(context));
  });

export const proactivityDatabase: Effect.Effect<
  D1Database,
  Cause.UnknownError | Schema.SchemaError
> = Effect.gen(function* () {
  const db = yield* Effect.tryPromise(() => proactivityTestDatabases.acquire());
  const names = Array.from(
    new Bun.Glob("*.sql").scanSync(new URL("./migrations/", import.meta.url).pathname)
  ).sort();
  yield* Effect.tryPromise(() =>
    installTestSchema({
      db,
      sources: names.map((name) => new URL(`./migrations/${name}`, import.meta.url)),
    })
  );
  const disclosure = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot))
  )(currentDisclosureFor());
  for (const subject of [
    { userId: proactivityTestUsers[0], caller: proactivityTestCallers[0] },
    { userId: proactivityTestUsers[1], caller: proactivityTestCallers[1] },
  ]) {
    const { userId, caller } = subject;
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
          )
          .bind(userId, proactivityTestNow.epochMilliseconds),
        db
          .prepare(
            "INSERT INTO whatsapp_identities(user_id,portfolio_id,bsuid,verified_at_ms) VALUES (?,?,?,?)"
          )
          .bind(
            userId,
            caller.businessPortfolioId,
            caller.businessScopedUserId,
            proactivityTestNow.epochMilliseconds
          ),
        db
          .prepare(
            "INSERT INTO onboarding_consent_records(id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES (?,?,?,'disclosed','accepted',0,0)"
          )
          .bind(userId, userId, disclosure),
      ])
    );
  }
  return db;
});
