import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { UserId, WhatsAppCallerReference } from "../../src/core/identity/contract";
import { DisclosureSnapshot } from "../../src/core/consent/contract";
import { currentDisclosureFor, weeklyDisclosureFor } from "../../src/shell/consent/operations";
import {
  createWeeklyConsentOffer,
  createWeeklyGovernorConsentOffer,
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

it.live("never proactively re-asks after a recorded no but permits a User-requested offer", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    const context = { db, userId, caller, now };
    const offer = Option.getOrThrow(yield* createWeeklyConsentOffer(context));
    yield* recordWeeklyConsentDisclosure({
      ...context,
      offerId: offer.id,
      disclosureMessageId: "no-disclosure",
    });
    expect(
      yield* decide({ ...context, choice: offer.declineChoice, decisionMessageId: "no-decision" })
    ).toBe(true);
    expect(Option.isNone(yield* createWeeklyConsentOffer(context))).toBe(true);
    expect(
      Option.isSome(
        yield* createWeeklyGovernorConsentOffer({
          ...context,
          request: {
            _tag: "GovernorQuestion",
            origin: "requested",
            sourceId: "49000000-0000-4000-8000-000000000001",
            requestedAt: now,
            rejectionOfferId: Option.some(offer.id),
          },
        })
      )
    ).toBe(true);
  })
);

it.live(
  "a later no invalidates outstanding offers and already-prepared acceptance atomically",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      const context = { db, userId, caller, now };
      const accepted = Option.getOrThrow(yield* createWeeklyConsentOffer(context));
      yield* recordWeeklyConsentDisclosure({
        ...context,
        offerId: accepted.id,
        disclosureMessageId: "accepted-disclosure",
      });
      expect(
        yield* decide({
          ...context,
          choice: accepted.acceptChoice,
          decisionMessageId: "accepted-choice",
        })
      ).toBe(true);
      const outstanding = Option.getOrThrow(yield* createWeeklyConsentOffer(context));
      yield* recordWeeklyConsentDisclosure({
        ...context,
        offerId: outstanding.id,
        disclosureMessageId: "outstanding-disclosure",
      });
      const prepared = Option.getOrThrow(
        yield* prepareWeeklyConsentDecision({
          ...context,
          choice: outstanding.acceptChoice,
          decisionMessageId: "prepared-choice",
        })
      );
      expect(
        yield* decide({ ...context, choice: accepted.revokeChoice, decisionMessageId: "later-no" })
      ).toBe(true);
      const stale = yield* Effect.exit(Effect.tryPromise(() => db.batch([...prepared.statements])));
      expect(stale._tag).toBe("Failure");
      expect(
        yield* decide({
          ...context,
          choice: outstanding.acceptChoice,
          decisionMessageId: "late-accept",
        })
      ).toBe(false);
      expect(Option.isNone(yield* findWeeklyConsentGrant({ db, userId }))).toBe(true);
      const original = yield* testPromise(() =>
        db
          .prepare("SELECT decision,decision_message_id FROM weekly_consent_offers WHERE id=?")
          .bind(accepted.id)
          .first()
      );
      expect(original).toMatchObject({
        decision: "accept",
        decision_message_id: "accepted-choice",
      });
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
