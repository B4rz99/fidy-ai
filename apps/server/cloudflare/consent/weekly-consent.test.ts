import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { UserId, WhatsAppCallerReference } from "../../src/core/identity/contract";
import { DisclosureSnapshot } from "../../src/core/consent/contract";
import { currentDisclosureFor, weeklyDisclosureFor } from "../../src/shell/consent/operations";
import {
  createWeeklyConsentOffer,
  findWeeklyConsentGrant,
  prepareWeeklyConsentAction,
  prepareWeeklyConsentDecision,
  recordWeeklyConsentDisclosure,
} from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = UserId.make("10000000-0000-4000-8000-000000000051");
const otherUser = UserId.make("10000000-0000-4000-8000-000000000052");
const caller = Schema.decodeSync(WhatsAppCallerReference)({
  businessPortfolioId: "portfolio",
  businessScopedUserId: "CO.abcdef",
});
const now = DateTime.makeUnsafe("2026-08-09T12:00:00Z");
const testPromise = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const decide = (
  input: Parameters<typeof prepareWeeklyConsentDecision>[0]
): Effect.Effect<boolean> =>
  prepareWeeklyConsentDecision(input).pipe(
    Effect.orDie,
    Effect.flatMap((decision) =>
      Option.isNone(decision)
        ? Effect.succeed(false)
        : Effect.tryPromise(() => input.db.batch([...decision.value.statements])).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false)
          )
    )
  );
const setup = (): Effect.Effect<D1Database> =>
  Effect.gen(function* () {
    const db = yield* testPromise(() => databases.acquire());
    const names = Array.from(
      new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
    );
    const sources = names
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => new URL(`../migrations/${name}`, import.meta.url));
    yield* testPromise(() => installTestSchema({ db, sources }));
    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot))
    )(currentDisclosureFor()).pipe(Effect.orDie);
    for (const id of [userId, otherUser]) {
      yield* testPromise(() =>
        db
          .prepare(
            "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO','es-CO','America/Bogota', ?)"
          )
          .bind(id, now.epochMilliseconds)
          .run()
      );
      yield* testPromise(() =>
        db
          .prepare(
            "INSERT INTO onboarding_consent_records (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES (?,?,?,'disclosed','accepted',?,?)"
          )
          .bind(id, id, json, 0, 0)
          .run()
      );
    }
    yield* testPromise(() =>
      db
        .prepare(
          "INSERT INTO whatsapp_identities (user_id,portfolio_id,bsuid,verified_at_ms) VALUES (?,?,?,?)"
        )
        .bind(
          userId,
          caller.businessPortfolioId,
          caller.businessScopedUserId,
          now.epochMilliseconds
        )
        .run()
    );
    return db;
  });

it.live(
  "requires a delivered exact disclosure, rejects foreign and inferred choices, and consumes explicit choices once",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      const context = { db, userId, caller, now };
      const offered = Option.getOrThrow(yield* createWeeklyConsentOffer(context));
      expect(
        yield* decide({ ...context, choice: offered.acceptChoice, decisionMessageId: "before" })
      ).toBe(false);
      expect(
        yield* recordWeeklyConsentDisclosure({
          ...context,
          offerId: offered.id,
          disclosureMessageId: "disclosure",
        })
      ).toBe(true);
      expect(
        yield* decide({
          ...context,
          userId: otherUser,
          choice: offered.acceptChoice,
          decisionMessageId: "foreign",
        })
      ).toBe(false);
      expect(yield* decide({ ...context, choice: "yes", decisionMessageId: "inferred" })).toBe(
        false
      );
      expect(
        yield* decide({ ...context, choice: offered.acceptChoice, decisionMessageId: "decision" })
      ).toBe(true);
      expect(
        yield* decide({ ...context, choice: offered.acceptChoice, decisionMessageId: "replay" })
      ).toBe(false);
      const grant = Option.getOrThrow(yield* findWeeklyConsentGrant({ db, userId }));
      const action = (): D1PreparedStatement =>
        prepareWeeklyConsentAction({
          db,
          userId,
          grantId: grant.id,
          statement: { sql: "SELECT 1 AS permitted WHERE 1 = 1", params: [] },
        });
      expect((yield* testPromise(() => action().all())).results).toHaveLength(1);
      const revoke = Option.getOrThrow(yield* createWeeklyConsentOffer(context));
      yield* recordWeeklyConsentDisclosure({
        ...context,
        offerId: revoke.id,
        disclosureMessageId: "revoke-disclosure",
      });
      expect(
        yield* decide({ ...context, choice: revoke.revokeChoice, decisionMessageId: "revoke" })
      ).toBe(true);
      expect(Option.isNone(yield* findWeeklyConsentGrant({ db, userId }))).toBe(true);
      expect((yield* testPromise(() => action().all())).results).toEqual([]);
    })
);

it.live(
  "rolls back Consent evidence with a failed caller-owned schedule action and refuses decisions at expiry",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      const context = { db, userId, caller, now };
      const offer = Option.getOrThrow(yield* createWeeklyConsentOffer(context));
      yield* recordWeeklyConsentDisclosure({
        ...context,
        offerId: offer.id,
        disclosureMessageId: "disclosure",
      });
      const decision = Option.getOrThrow(
        yield* prepareWeeklyConsentDecision({
          ...context,
          choice: offer.acceptChoice,
          decisionMessageId: "decision",
        })
      );
      const failed = yield* Effect.exit(
        Effect.tryPromise(() =>
          db.batch([
            ...decision.statements,
            db.prepare("INSERT INTO weekly_schedule_assertion (id,accepted) VALUES (1,0)"),
          ])
        )
      );
      expect(failed._tag).toBe("Failure");
      expect(Option.isNone(yield* findWeeklyConsentGrant({ db, userId }))).toBe(true);
      expect(
        yield* decide({
          ...context,
          now: DateTime.add(now, { minutes: 10 }),
          choice: offer.acceptChoice,
          decisionMessageId: "late",
        })
      ).toBe(false);
      expect(
        yield* decide({ ...context, choice: offer.declineChoice, decisionMessageId: "decline" })
      ).toBe(true);
      expect(Option.isNone(yield* findWeeklyConsentGrant({ db, userId }))).toBe(true);
    })
);

it.live("retains the exact source-controlled disclosure digest", () =>
  Effect.gen(function* () {
    const disclosure = weeklyDisclosureFor();
    const digest = yield* testPromise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(disclosure.text))
    );
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    expect(disclosure.contentSha256).toBe(hex);
  })
);
