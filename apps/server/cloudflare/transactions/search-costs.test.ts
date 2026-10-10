import { Data, Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { dashboardTransactionQueries } from "./internal/dashboard-query";
import { Transaction } from "../../src/core/transactions/contract";

class SearchFixtureFailure extends Data.TaggedError("SearchFixtureFailure") {}
const fromTestPromise = <Value>(run: () => PromiseLike<Value>): Effect.Effect<Value> =>
  Effect.tryPromise({
    try: run,
    catch: () => new SearchFixtureFailure(),
  }).pipe(Effect.orDie);
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000051";
const foreignUserId = "10000000-0000-4000-8000-000000000052";
const categoryId = "10000000-0000-4000-8000-000000000001";
const prefix = "20000000-0000-4000-8000-";
const foreignPrefix = "30000000-0000-4000-8000-";

const setup = (): Effect.Effect<D1Database> =>
  Effect.gen(function* () {
    const db = yield* fromTestPromise(() => databases.acquire());
    yield* fromTestPromise(() =>
      installTestSchema({
        db,
        sources: Array.from(
          new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
        )
          .sort()
          .map((name) => new URL(`../migrations/${name}`, import.meta.url)),
      })
    );
    yield* fromTestPromise(() =>
      db.batch(
        [userId, foreignUserId].map((subject) =>
          db
            .prepare(`INSERT INTO users(id, service_market, locale, time_zone, created_at_ms)
              VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)`)
            .bind(subject)
        )
      )
    );
    return db;
  });

// This owner adapter test arranges retained effective leaves directly to isolate search read cost.
// All migrated FTS-maintenance triggers run, and no request or projection-repair work is measured.
const seedLeaves = (
  db: D1Database,
  subject: string,
  transactionPrefix: string
): Effect.Effect<void> =>
  fromTestPromise(() =>
    db
      .prepare(`WITH RECURSIVE sequence(number) AS (
        SELECT 1 UNION ALL SELECT number + 1 FROM sequence WHERE number < 2000
      )
      INSERT INTO dashboard_projection_leaf
        (user_id, id, amount, currency, direction, category_id, counterparty, notes,
          occurred_at, created_at, revision)
      SELECT ?, ? || printf('%012d', number), '1', 'COP', 'outflow', ?, NULL,
        CASE WHEN ? = 1 THEN 'Café common unique foreignonly note'
          WHEN number = 1 THEN 'Café unique oldest note' ELSE 'Café common note' END,
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || number || ' minutes'),
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || number || ' minutes'), 0
      FROM sequence`)
      .bind(subject, transactionPrefix, categoryId, subject === foreignUserId ? 1 : 0)
      .run()
  ).pipe(Effect.asVoid);

const searchPage = (
  db: D1Database,
  search: string,
  selection: Readonly<{ categories: ReadonlyArray<string>; limit: number }> = {
    categories: [],
    limit: 50,
  }
): Promise<D1Result> =>
  db
    .batch([
      ...dashboardTransactionQueries({
        db,
        userId,
        lists: [{ search: Option.some(search), ...selection }],
      }),
    ])
    .then(([page]) => {
      if (page === undefined) throw new Error("Missing search result");
      return page;
    });

it(
  "does not read another User's matching notes to return an effective Transaction search page",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* seedLeaves(db, userId, prefix);
        const baseline = yield* fromTestPromise(() => searchPage(db, "CAFÉ"));
        expect(baseline.results).toHaveLength(50);
        expect(baseline.meta.rows_read).toBeLessThanOrEqual(51);
        expect(baseline.results[0]).toMatchObject({
          id: `${prefix}000000002000`,
          notes: "Café common note",
        });
        expect(baseline.results[49]).toMatchObject({ id: `${prefix}000000001951` });
        yield* seedLeaves(db, foreignUserId, foreignPrefix);
        const expanded = yield* fromTestPromise(() => searchPage(db, "CAFÉ"));
        expect(expanded.results).toEqual(baseline.results);
        expect(expanded.meta.rows_read).toBeLessThanOrEqual(baseline.meta.rows_read + 10);
        yield* fromTestPromise(() => db.prepare("ANALYZE").run());
        const analyzed = yield* fromTestPromise(() => searchPage(db, "CAFÉ"));
        expect(analyzed.results).toEqual(baseline.results);
        expect(analyzed.meta.rows_read).toBeLessThanOrEqual(baseline.meta.rows_read + 10);
      })
    ),
  30_000
);

it(
  "bounds rare and absent searches by the requesting User's effective history",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* seedLeaves(db, userId, prefix);
        const searches = ["unique", "missing", "foreignonly"];
        const baseline = yield* Effect.forEach(searches, (search) =>
          fromTestPromise(() => searchPage(db, search))
        );
        expect(baseline[0]?.results).toMatchObject([{ id: `${prefix}000000000001` }]);
        expect(baseline[1]?.results).toEqual([]);
        expect(baseline[2]?.results).toEqual([]);
        yield* seedLeaves(db, foreignUserId, foreignPrefix);
        for (const analyzed of [false, true]) {
          if (analyzed) yield* fromTestPromise(() => db.prepare("ANALYZE").run());
          const pages = yield* Effect.forEach(searches, (search) =>
            fromTestPromise(() => searchPage(db, search))
          );
          for (const [index, page] of pages.entries()) {
            expect(page.results).toEqual(baseline[index]?.results);
            expect(page.meta.rows_read).toBeLessThanOrEqual(2_002);
          }
        }
      })
    ),
  30_000
);

const recordId = (index: number): string => `${prefix}${String(index).padStart(12, "0")}`;
const secondCategoryId = "10000000-0000-4000-8000-000000000002";
const notesDefaults = {
  userId,
  categoryId,
  notes: "Retained note",
  counterparty: Option.none<string>(),
};
const notesFixture = (
  db: D1Database,
  index: number,
  overrides: Partial<typeof notesDefaults> = {}
): D1PreparedStatement => {
  const input = { ...notesDefaults, ...overrides };
  return db
    .prepare(`INSERT INTO transactions
      (id, user_id, amount, currency, direction, category_id, counterparty, notes,
        occurred_at, created_at)
      VALUES (?, ?, '1', 'COP', 'outflow', ?, ?, ?,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
    .bind(
      recordId(index),
      input.userId,
      input.categoryId,
      Option.getOrNull(input.counterparty),
      input.notes
    );
};
const transactionIds = (page: D1Result): ReadonlyArray<string> =>
  Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Transaction.fields.id })))(
    page.results
  ).map((row) => row.id);

it(
  "preserves literal punctuation, Unicode, short terms, category selection and deterministic limits",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* fromTestPromise(() =>
          db.batch([
            notesFixture(db, 1, { notes: "Café CAFÉ fé É Ñ" }),
            notesFixture(db, 2, { notes: "Cafe\u0301 cafe\u0301" }),
            notesFixture(db, 3, { notes: '100% real_under_score "double" O\'Brien' }),
            notesFixture(db, 4, { notes: "100x realXunderXscore double OBrien" }),
            notesFixture(db, 5, { notes: "emoji 😀 familia 👩‍👩‍👧‍👦" }),
            notesFixture(db, 6, { notes: "東京 中文 العربية" }),
            notesFixture(db, 7, { notes: 'percent % underscore _ quote " section §' }),
            notesFixture(db, 8, { notes: "path C:\\new\\line / [] .* + ?" }),
            notesFixture(db, 9, { notes: 'A "quoted" Café' }),
            notesFixture(db, 10, { notes: "CAFÉ category two", categoryId: secondCategoryId }),
            notesFixture(db, 11, {
              notes: 'foreignonly Café % _ " 😀 東京',
              userId: foreignUserId,
            }),
            notesFixture(db, 12, {
              notes: "cross boundary",
              counterparty: Option.some("Contraparte"),
            }),
          ])
        );
        const cases: ReadonlyArray<Readonly<{ search: string; expected: ReadonlyArray<number> }>> =
          [
            { search: "%", expected: [7, 3] },
            { search: "_", expected: [7, 3] },
            { search: '"', expected: [9, 7, 3] },
            { search: '"double"', expected: [3] },
            { search: "O'Brien", expected: [3] },
            { search: "CAFÉ", expected: [10, 9, 1] },
            { search: "fé", expected: [10, 9, 1] },
            { search: "é", expected: [10, 9, 1] },
            { search: "Ñ", expected: [1] },
            { search: "cafe", expected: [2] },
            { search: "Cafe\u0301", expected: [2] },
            { search: "e\u0301", expected: [2] },
            { search: "\u0301", expected: [2] },
            { search: "😀", expected: [5] },
            { search: "👩‍", expected: [5] },
            { search: "👩‍👩", expected: [5] },
            { search: "東京", expected: [6] },
            { search: "京", expected: [6] },
            { search: "中文", expected: [6] },
            { search: "العربية", expected: [6] },
            { search: "§", expected: [7] },
            { search: "[]", expected: [8] },
            { search: ".*", expected: [8] },
            { search: "C:\\new", expected: [8] },
            { search: "partE crOss", expected: [12] },
            { search: "foreignonly", expected: [] },
            { search: "☃", expected: [] },
            { search: "' OR 1=1 --", expected: [] },
          ];
        for (const { search, expected } of cases) {
          const page = yield* fromTestPromise(() => searchPage(db, search));
          expect(transactionIds(page), search).toEqual(expected.map(recordId));
        }
        const selected = yield* fromTestPromise(() =>
          searchPage(db, "café", { categories: [categoryId], limit: 50 })
        );
        expect(transactionIds(selected)).toEqual([recordId(9), recordId(1)]);
        const other = yield* fromTestPromise(() =>
          searchPage(db, "café", { categories: [secondCategoryId], limit: 50 })
        );
        expect(transactionIds(other)).toEqual([recordId(10)]);
        const limited = yield* fromTestPromise(() =>
          searchPage(db, "café", { categories: [categoryId, secondCategoryId], limit: 2 })
        );
        expect(transactionIds(limited)).toEqual([recordId(10), recordId(9)]);
      })
    ),
  30_000
);

it(
  "searches the visible Reconciliation member using corrected effective notes",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* fromTestPromise(() =>
          db.batch([
            notesFixture(db, 1, { notes: "Visible fallback" }),
            notesFixture(db, 2, { notes: "Original Café" }),
            notesFixture(db, 3, { notes: "Café foreign private", userId: foreignUserId }),
            db
              .prepare("UPDATE transactions SET user_decisions = '{\"notes\":true}' WHERE id = ?")
              .bind(recordId(2)),
            db
              .prepare(`INSERT INTO transaction_reconciliation_decisions
                (user_id, first_transaction_id, second_transaction_id, state,
                  visible_transaction_id, decided_at)
                VALUES (?, ?, ?, 'linked', ?, '2026-01-01T01:00:00.000Z')`)
              .bind(userId, recordId(1), recordId(2), recordId(1)),
            db
              .prepare(`INSERT INTO transaction_reconciliation_members
                (user_id, transaction_id, first_transaction_id, second_transaction_id)
                VALUES (?, ?, ?, ?), (?, ?, ?, ?)`)
              .bind(
                userId,
                recordId(1),
                recordId(1),
                recordId(2),
                userId,
                recordId(2),
                recordId(1),
                recordId(2)
              ),
          ])
        );
        const linked = yield* fromTestPromise(() => searchPage(db, "CAFÉ"));
        expect(linked.results).toMatchObject([{ id: recordId(1), notes: "Original Café" }]);
        const suppressed = yield* fromTestPromise(() => searchPage(db, "fallback"));
        expect(suppressed.results).toEqual([]);
        yield* fromTestPromise(() =>
          db.batch([
            db
              .prepare(`INSERT INTO transaction_corrections
                (id, user_id, transaction_id, previous_revision, changed_fields,
                  before_facts, after_facts, corrected_at)
                VALUES (?, ?, ?, 0, '["notes"]', '{}', '{}', '2026-01-02T00:00:00.000Z')`)
              .bind("40000000-0000-4000-8000-000000000001", userId, recordId(2)),
            db
              .prepare(`UPDATE transactions SET notes = 'Replacement 😀', revision = 1
                WHERE user_id = ? AND id = ?`)
              .bind(userId, recordId(2)),
          ])
        );
        const removed = yield* fromTestPromise(() => searchPage(db, "CAFÉ"));
        expect(removed.results).toEqual([]);
        const corrected = yield* fromTestPromise(() => searchPage(db, "😀"));
        expect(corrected.results).toMatchObject([{ id: recordId(1), notes: "Replacement 😀" }]);
      })
    ),
  30_000
);
