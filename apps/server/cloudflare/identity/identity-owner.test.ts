import { readMemoryContext } from "../memory/operations";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
  WhatsAppCallerReference,
} from "../../src/core/identity/contract";
import { afterAll, expect, it } from "vitest";
import { Effect, Option, Result, Schema } from "effect";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { PendingConsentExchangeId } from "../../src/shell/consent/contract";
import {
  findWhatsAppUser,
  prepareOnboardingWhatsAppAssociation,
  prepareUserCreation,
  prepareWhatsAppIdentity,
  whatsAppIdentityQuery,
} from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userA = UserId.make("10000000-0000-4000-8000-000000000001");
const userB = UserId.make("10000000-0000-4000-8000-000000000002");

it("resolves only the established portfolio and BSUID pair without borrowing contact evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(`CREATE TABLE whatsapp_identities (user_id TEXT, portfolio_id TEXT, bsuid TEXT,
      verified_at_ms INTEGER)`),
          db
            .prepare("INSERT INTO whatsapp_identities VALUES (?, 'portfolio-a', 'CO.caller', 1000)")
            .bind(userA),
          db
            .prepare("INSERT INTO whatsapp_identities VALUES (?, 'portfolio-b', 'CO.caller', 1000)")
            .bind(userB),
        ])
      );
      expect(
        yield* findWhatsAppUser({
          db,
          portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-a"),
          bsuid: WhatsAppBusinessScopedUserId.make("CO.caller"),
        })
      ).toEqual(Option.some(userA));
      expect(
        yield* findWhatsAppUser({
          db,
          portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-b"),
          bsuid: WhatsAppBusinessScopedUserId.make("CO.caller"),
        })
      ).toEqual(Option.some(userB));
      expect(
        yield* findWhatsAppUser({
          db,
          portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-a"),
          bsuid: WhatsAppBusinessScopedUserId.make("CO.unknown"),
        })
      ).toEqual(Option.none());
      expect(
        Schema.decodeOption(WhatsAppCallerReference)({
          businessPortfolioId: "portfolio-a",
          businessScopedUserId: "+573001234567",
        })
      ).toEqual(Option.none());
      expect(
        Schema.decodeOption(WhatsAppCallerReference)({
          businessPortfolioId: "portfolio-a",
          businessScopedUserId: "contact-123",
        })
      ).toEqual(Option.none());
      expect(
        Schema.decodeOption(WhatsAppCallerReference)({
          businessPortfolioId: "portfolio-a",
          businessScopedUserId: "CO.ENT.caller",
        })
      ).toEqual(Option.none());
    })
  ));

it("rechecks the exact User association at execution and refuses cross-User substitution without effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE whatsapp_identities (user_id TEXT, portfolio_id TEXT, bsuid TEXT, verified_at_ms INTEGER)"
          ),
          db.prepare("CREATE TABLE protected_work (user_id TEXT)"),
          db
            .prepare("INSERT INTO whatsapp_identities VALUES (?, 'portfolio-a', 'CO.caller', 1000)")
            .bind(userA),
          db
            .prepare("INSERT INTO whatsapp_identities VALUES (?, 'portfolio-a', 'CO.other', 1000)")
            .bind(userB),
        ])
      );
      const guard = whatsAppIdentityQuery({
        userId: userB,
        portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-a"),
        bsuid: WhatsAppBusinessScopedUserId.make("CO.caller"),
      });
      const guarded = db
        .prepare(`INSERT INTO protected_work SELECT userId FROM (${guard.sql})`)
        .bind(...guard.params);
      yield* Effect.tryPromise(() => guarded.run());
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT * FROM protected_work").all())
      ).toMatchObject({ results: [] });
      const prepared = prepareWhatsAppIdentity({
        db,
        userId: userA,
        statement: {
          sql: "INSERT INTO protected_work SELECT userId FROM identity_associations WHERE businessPortfolioId = ? AND businessScopedUserId = ?",
          params: ["portfolio-a", "CO.caller"],
        },
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE whatsapp_identities SET bsuid = 'CO.changed' WHERE user_id = ?")
          .bind(userA)
          .run()
      );
      yield* Effect.tryPromise(() => prepared.run());
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT * FROM protected_work").all())
      ).toMatchObject({ results: [] });
      const current = whatsAppIdentityQuery({
        userId: userA,
        portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-a"),
        bsuid: WhatsAppBusinessScopedUserId.make("CO.changed"),
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO protected_work SELECT userId FROM (${current.sql})`)
          .bind(...current.params)
          .run()
      );
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT * FROM protected_work").all())
      ).toMatchObject({ results: [{ user_id: userA }] });
    })
  ));

it("keeps User, WhatsApp association and original TrialPeriod inside the caller's atomic verification unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE users (id TEXT PRIMARY KEY, service_market TEXT, locale TEXT, time_zone TEXT, created_at_ms INTEGER)"
          ),
          db.prepare(
            "CREATE TABLE whatsapp_identities (user_id TEXT PRIMARY KEY REFERENCES users(id), portfolio_id TEXT, bsuid TEXT, verified_at_ms INTEGER, phone_number_id TEXT, UNIQUE(portfolio_id, bsuid))"
          ),
          db.prepare(
            "CREATE TABLE trial_periods (user_id TEXT PRIMARY KEY REFERENCES users(id), started_at_ms INTEGER, ends_at_ms INTEGER)"
          ),
          db.prepare(
            "CREATE TABLE pending_consent_exchanges (id TEXT PRIMARY KEY, portfolio_id TEXT, bsuid TEXT, phone_number_id TEXT, expires_at_ms INTEGER, state TEXT)"
          ),
          db.prepare(
            "INSERT INTO pending_consent_exchanges VALUES ('10000000-0000-4000-8000-000000000003', 'portfolio-a', 'CO.caller', 'phone-a', 86401000, 'accepted')"
          ),
          db.prepare("CREATE TABLE verification_completion (valid INTEGER CHECK(valid = 1))"),
        ])
      );
      const identity = prepareUserCreation({
        db,
        userId: userA,
        createdAtMs: 1000,
      });
      const associateCaller = prepareOnboardingWhatsAppAssociation({
        db,
        userId: userA,
        exchangeId: PendingConsentExchangeId.make("10000000-0000-4000-8000-000000000003"),
        createdAtMs: 1000,
      });
      const failed = yield* Effect.result(
        Effect.tryPromise(() =>
          db.batch([
            identity.createUser,
            associateCaller,
            identity.startTrial,
            db.prepare("INSERT INTO verification_completion VALUES (0)"),
          ])
        )
      );
      expect(Result.isFailure(failed)).toBe(true);
      expect(
        yield* findWhatsAppUser({
          db,
          portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-a"),
          bsuid: WhatsAppBusinessScopedUserId.make("CO.caller"),
        })
      ).toEqual(Option.none());
      expect(yield* Effect.tryPromise(() => db.prepare("SELECT * FROM users").all())).toMatchObject(
        { results: [] }
      );
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT * FROM trial_periods").all())
      ).toMatchObject({ results: [] });
      yield* Effect.tryPromise(() =>
        db.batch([
          identity.createUser,
          associateCaller,
          identity.startTrial,
          db.prepare("INSERT INTO verification_completion VALUES (1)"),
        ])
      );
      expect(
        yield* findWhatsAppUser({
          db,
          portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-a"),
          bsuid: WhatsAppBusinessScopedUserId.make("CO.caller"),
        })
      ).toEqual(Option.some(userA));
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT * FROM trial_periods").all())
      ).toMatchObject({
        results: [{ user_id: userA, started_at_ms: 1000, ends_at_ms: 604801000 }],
      });
    })
  ));

it("does not release another User's Memory through a valid but borrowed association query", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE whatsapp_identities (user_id TEXT, portfolio_id TEXT, bsuid TEXT)"
          ),
          db.prepare(
            "CREATE TABLE memories (id TEXT, user_id TEXT, text TEXT, created_at TEXT, updated_at TEXT)"
          ),
          db
            .prepare("INSERT INTO whatsapp_identities VALUES (?, 'portfolio-a', 'CO.caller')")
            .bind(userA),
          db
            .prepare(
              "INSERT INTO memories VALUES ('30000000-0000-4000-8000-000000000001', ?, 'A private context', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')"
            )
            .bind(userA),
          db
            .prepare(
              "INSERT INTO memories VALUES ('30000000-0000-4000-8000-000000000002', ?, 'B private context', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')"
            )
            .bind(userB),
        ])
      );
      const authority = whatsAppIdentityQuery({
        userId: userA,
        portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-a"),
        bsuid: WhatsAppBusinessScopedUserId.make("CO.caller"),
      });
      expect(yield* readMemoryContext({ db, userId: userB, authority })).toEqual(Option.some([]));
      expect(yield* readMemoryContext({ db, userId: userA, authority })).toEqual(
        Option.some([{ text: "A private context" }])
      );
      const retained = yield* Effect.tryPromise(() =>
        db.prepare("SELECT text FROM memories ORDER BY id").all()
      );
      expect(retained.results).toEqual([
        { text: "A private context" },
        { text: "B private context" },
      ]);
      // A malformed current row makes the entire owned context unavailable, not partially visible.
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO memories VALUES ('invalid', ?, 'malformed private context', '2026-10-01', '2026-10-01')"
          )
          .bind(userA)
          .run()
      );
      expect(yield* readMemoryContext({ db, userId: userA, authority })).toEqual(Option.none());
      expect(yield* readMemoryContext({ db, userId: userB, authority })).toEqual(Option.some([]));
    })
  ));
