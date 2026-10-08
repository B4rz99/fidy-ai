import { afterAll, expect, it } from "vitest";
import { type Cause, DateTime, Effect, Exit, Option, Schema } from "effect";
import { UserContext, UserId } from "../../src/core/identity/contract";

import { Currency, encodeMoneyAmount } from "../../src/core/_shared/money";
import { CategoryId } from "../../src/core/categories/contract";
import { prepareUserContext } from "../identity/user-context/operations";
import { listCategories } from "../categories/operations";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { type BudgetContributionQuery, TransactionAggregatesUnavailable } from "./contract";
import {
  findRecurringSnapshot,
  preparePeriodAggregateGuard,
  prepareRecurringFactGuard,
  readBudgetContributions,
  readCompletePeriodAggregates,
  readDashboardTransactions,
  readRecurringFacts,
} from "./operations";

const databases = isolatedTestDatabases();
const userId = "10000000-0000-4000-8000-000000000051";
const otherUserId = "10000000-0000-4000-8000-000000000052";
const categoryId = CategoryId.make("10000000-0000-4000-8000-000000000016");
const otherCategoryId = CategoryId.make("10000000-0000-4000-8000-000000000015");
const from = DateTime.makeUnsafe("2026-05-01T05:00:00.000Z");
const to = DateTime.makeUnsafe("2026-06-01T05:00:00.000Z");
const transactionId = (index: number): string =>
  `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const setup = (): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    yield* Effect.tryPromise(() =>
      installTestSchema({
        db,
        sources: [
          "0001_categories",
          "0003_pending_consent",
          "0005_verified_onboarding",
          "0006_browser_login",
          "0009_transactions",
          "0010_pat_lifecycle",
          "0011_transaction_corrections",
          "0012_statement_staging",
          "0012_transaction_search",
          "0013_category_keyword_rules",
          "0013_transaction_reconciliation",
          "0014_memory",
          "0015_statement_submission",
          "0016_budgets",
          "0037_budget_crossing_facts",
          "0017_statement_dispatch",
          "0018_dashboard",
          "0019_canonical_child_guards",
          "0020_dashboard_projection",
          "0027_recurring",
        ].map((name) => new URL(`../migrations/${name}.sql`, import.meta.url)),
      })
    );
    yield* Effect.tryPromise(() =>
      db.batch(
        [userId, otherUserId].map((subject) =>
          db
            .prepare(`INSERT INTO users (id, service_market, locale, time_zone, created_at_ms)
      VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)`)
            .bind(subject)
        )
      )
    );
    yield* Effect.tryPromise(() =>
      db.batch(
        [userId, otherUserId].map((subject) =>
          db
            .prepare(
              `INSERT INTO onboarding_consent_records (id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, accepted_at_ms) VALUES (?, ?, '{}', 'disclosure', 'decision', 0, 0)`
            )
            .bind(subject, subject)
        )
      )
    );
    return db;
  });
afterAll(() => databases.dispose());

it("projects only one User's recurring facts and rolls back a stale revision commit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.batch([
          movement(db, 1),
          movement(db, 2, { userId: otherUserId }),
          movement(db, 3, { direction: "inflow" }),
        ])
      );
      const snapshot = Option.getOrThrow(
        yield* findRecurringSnapshot({ db, userId: UserId.make(userId) })
      );
      const query = {
        db,
        userId: UserId.make(userId),
        revision: snapshot.revision,
        cursor: { occurredAt: "", transactionId: "" },
      };
      const page = Option.getOrThrow(yield* readRecurringFacts(query));
      expect(page.facts.map((fact) => fact.id)).toEqual([transactionId(1)]);
      yield* Effect.tryPromise(() => movement(db, 4).run());
      expect(Option.isNone(yield* readRecurringFacts(query))).toBe(true);
      yield* Effect.tryPromise(() =>
        db.prepare("CREATE TABLE peer_result (value TEXT NOT NULL) STRICT").run()
      );
      const rejected = yield* Effect.exit(
        Effect.tryPromise(() =>
          db.batch([
            db.prepare("INSERT INTO peer_result (value) VALUES ('published')"),
            prepareRecurringFactGuard(query),
          ])
        )
      );
      expect(rejected._tag).toBe("Failure");
      const unchanged = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM peer_result").all()
      );
      expect(unchanged.results).toEqual([]);
    })
  ));

it("reads complete exact two-period aggregates from one owned effective revision", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.batch([
          movement(db, 1, { amount: "9007199254740993.01" }),
          movement(db, 2, { amount: "0.02" }),
          movement(db, 3, { amount: "7", direction: "inflow", currency: "USD" }),
          movement(db, 4, { userId: otherUserId, amount: "999" }),
          movement(db, 5, { occurredAt: "2026-04-30T05:00:00.000Z", amount: "4" }),
          movement(db, 6, { occurredAt: DateTime.formatIso(to), amount: "100" }),
        ])
      );
      const facts = Option.getOrThrow(
        yield* readCompletePeriodAggregates({
          db,
          userId: UserId.make(userId),
          periods: [
            { from, toExclusive: to },
            { from: DateTime.makeUnsafe("2026-04-01T05:00:00.000Z"), toExclusive: from },
          ],
        })
      );
      expect(facts.revision).toBeGreaterThan(0);
      expect(
        facts.periods.map((selection) =>
          selection.aggregates.map((fact) => ({
            currency: fact.sum.currency,
            amount: encodeMoneyAmount(fact.sum.amount),
            direction: fact.direction,
            count: fact.count,
          }))
        )
      ).toEqual([
        [
          { currency: "COP", amount: "9007199254740993.03", direction: "outflow", count: 2n },
          { currency: "USD", amount: "7", direction: "inflow", count: 1n },
        ],
        [{ currency: "COP", amount: "4", direction: "outflow", count: 1n }],
      ]);
    })
  ));

it("rolls back stale aggregate publication and distinguishes authorized empty history from missing readiness", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const query = {
        db,
        userId: UserId.make(userId),
        periods: [
          { from, toExclusive: to },
          { from: DateTime.makeUnsafe("2026-04-01T05:00:00.000Z"), toExclusive: from },
        ],
      } as const;
      const empty = Option.getOrThrow(yield* readCompletePeriodAggregates(query));
      expect(empty.revision).toBe(0);
      expect(empty.periods.map((selection) => selection.aggregates)).toEqual([[], []]);
      yield* Effect.tryPromise(() =>
        db.prepare("CREATE TABLE report_publication (value TEXT) STRICT").run()
      );
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("INSERT INTO report_publication VALUES ('empty')"),
          preparePeriodAggregateGuard({ db, userId: query.userId, revision: empty.revision }),
        ])
      );
      yield* Effect.tryPromise(() => movement(db, 1).run());
      const refused = yield* Effect.exit(
        Effect.tryPromise(() =>
          db.batch([
            db.prepare("INSERT INTO report_publication VALUES ('stale')"),
            preparePeriodAggregateGuard({ db, userId: query.userId, revision: empty.revision }),
          ])
        )
      );
      expect(refused._tag).toBe("Failure");
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT value FROM report_publication").all()))
          .results
      ).toEqual([{ value: "empty" }]);
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE dashboard_projection_state SET readiness = 'dirty' WHERE user_id = ?")
          .bind(userId)
          .run()
      );
      expect(Option.isNone(yield* readCompletePeriodAggregates(query))).toBe(true);
    })
  ));

it("fails malformed retained aggregate precision through the published typed channel", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() => movement(db, 1, { amount: "1" }).run());
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE dashboard_projection_digit SET digit_sum = CASE WHEN position = 0 THEN 1 ELSE 0 END WHERE user_id = ?"
          )
          .bind(userId)
          .run()
      );
      const outcome = yield* Effect.exit(
        readCompletePeriodAggregates({
          db,
          userId: UserId.make(userId),
          periods: [
            { from, toExclusive: to },
            { from: DateTime.makeUnsafe("2026-04-01T05:00:00.000Z"), toExclusive: from },
          ],
        })
      );
      expect(outcome).toEqual(Exit.fail(new TransactionAggregatesUnavailable()));
    })
  ));

const movementDefaults = {
  userId,
  amount: "0.01",
  currency: "COP",
  categoryId: String(categoryId),
  direction: "outflow",
  occurredAt: DateTime.formatIso(from),
  counterparty: "ÁRBOL tienda",
};
const movement = (
  db: D1Database,
  index: number,
  overrides: Partial<typeof movementDefaults> = {}
): D1PreparedStatement => {
  const input = { ...movementDefaults, ...overrides };
  return db
    .prepare(`INSERT INTO transactions
    (id, user_id, amount, currency, category_id, direction, occurred_at, created_at, counterparty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      transactionId(index),
      input.userId,
      input.amount,
      input.currency,
      input.categoryId,
      input.direction,
      input.occurredAt,
      DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2025, 0, index + 1))),
      input.counterparty
    );
};

const budgetQuery = (db: D1Database): BudgetContributionQuery => ({
  db,
  userId,
  categoryId,
  currency: Currency.make("COP"),
  period: { from, to },
  cursor: { occurredAt: DateTime.formatIso(from), transactionId: "" },
});

it("reads exact owned Budget outflows in a half-open interval and resumes equal-time identities", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.batch([
          movement(db, 1, { amount: "9007199254740993.01" }),
          movement(db, 2, { amount: "0.02" }),
          movement(db, 3, { userId: otherUserId }),
          movement(db, 4, { currency: "USD" }),
          movement(db, 5, { direction: "inflow" }),
          movement(db, 6, { categoryId: otherCategoryId }),
          movement(db, 7, { occurredAt: "2026-05-01T04:59:59.999Z" }),
          movement(db, 8, { occurredAt: DateTime.formatIso(to) }),
        ])
      );
      const first = Option.getOrThrow(yield* readBudgetContributions(budgetQuery(db)));
      expect(
        first.movements.map((value) => ({
          amount: encodeMoneyAmount(value.money.amount),
          currency: value.money.currency,
          categoryId: value.categoryId,
          direction: value.direction,
          occurredAt: DateTime.formatIso(value.occurredAt),
        }))
      ).toEqual([
        {
          amount: "9007199254740993.01",
          currency: "COP",
          categoryId,
          direction: "outflow",
          occurredAt: DateTime.formatIso(from),
        },
        {
          amount: "0.02",
          currency: "COP",
          categoryId,
          direction: "outflow",
          occurredAt: DateTime.formatIso(from),
        },
      ]);
      const resumed = Option.getOrThrow(
        yield* readBudgetContributions({
          ...budgetQuery(db),
          cursor: { occurredAt: DateTime.formatIso(from), transactionId: transactionId(1) },
        })
      );
      expect(resumed.movements.map((value) => encodeMoneyAmount(value.money.amount))).toEqual([
        "0.02",
      ]);
      expect(resumed.cursor.transactionId).toBe(transactionId(2));
      expect(resumed.complete).toBe(true);
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE transactions SET amount = '0.001' WHERE id = ?")
          .bind(transactionId(2))
          .run()
      );
      expect(Option.isNone(yield* readBudgetContributions(budgetQuery(db)))).toBe(true);
    })
  ));

it("caps each contribution page and resumes beyond a full page without losing its final identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.batch(Array.from({ length: 513 }, (_, index) => movement(db, index + 1)))
      );
      const first = Option.getOrThrow(yield* readBudgetContributions(budgetQuery(db)));
      expect(first.movements).toHaveLength(512);
      expect(first.complete).toBe(false);
      expect(first.cursor.transactionId).toBe(transactionId(512));
      const last = Option.getOrThrow(
        yield* readBudgetContributions({ ...budgetQuery(db), cursor: first.cursor })
      );
      expect(last.movements).toHaveLength(1);
      expect(last.complete).toBe(true);
      expect(last.cursor.transactionId).toBe(transactionId(513));
    })
  ));

it("returns ready owned Dashboard pages with caller context and refuses incomplete or malformed projections", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.batch([
          movement(db, 1),
          movement(db, 2, { categoryId: otherCategoryId }),
          movement(db, 3, { userId: otherUserId }),
          movement(db, 4, { counterparty: "Otra tienda" }),
        ])
      );
      const categories = yield* listCategories({ db });
      const query = {
        db,
        userId,
        categories,
        lists: [{ categories: [categoryId], search: Option.some("árb"), limit: 1 }],
        snapshot: {
          statement: prepareUserContext({
            db,
            userId: UserId.make(userId),
            statement: {
              sql: "SELECT serviceMarket, locale, timeZone FROM identity_user_context",
              params: [],
            },
          }),
          decode: (rows: ReadonlyArray<unknown>): Option.Option<UserContext> =>
            Schema.decodeUnknownOption(UserContext)(rows[0]),
        },
      };
      const found = Option.getOrThrow(yield* readDashboardTransactions(query));
      expect(found.snapshot).toEqual({
        serviceMarket: "CO",
        locale: "es-CO",
        timeZone: "America/Bogota",
      });
      expect(found.lists.map((page) => page.map((fact) => fact.transaction.id))).toEqual([
        [transactionId(1)],
      ]);
      expect(found.lists[0]?.[0]?.category.id).toBe(categoryId);
      expect(
        Option.isNone(
          yield* readDashboardTransactions({
            ...query,
            lists: [{ categories: [], search: Option.none(), limit: 51 }],
          })
        )
      ).toBe(true);
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE dashboard_projection_state SET readiness = 'dirty' WHERE user_id = ?")
          .bind(userId)
          .run()
      );
      expect(Option.isNone(yield* readDashboardTransactions(query))).toBe(true);
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare("UPDATE dashboard_projection_state SET readiness = 'ready' WHERE user_id = ?")
            .bind(userId),
          db
            .prepare(
              "UPDATE dashboard_projection_leaf SET revision = -1 WHERE user_id = ? AND id = ?"
            )
            .bind(userId, transactionId(1)),
        ])
      );
      expect(Option.isNone(yield* readDashboardTransactions(query))).toBe(true);
    })
  ));
