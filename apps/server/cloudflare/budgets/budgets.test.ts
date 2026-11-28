import { NodeFileSystem } from "@effect/platform-node";
import { nativeTransactionJourney, seedNativePAT } from "../financial-user-store.test-fixture";
import { type Cause, DateTime, Effect, Array as EffectArray, Option, Schema } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Budget, BudgetStatusReport } from "../../src/core/budgets/contract";
import { IanaTimeZone } from "../../src/core/_shared/context";
import { deriveCurrentBudgetMonth } from "../../src/core/budgets/operations";
import { encodeMoneyAmount } from "../../src/core/_shared/money";
import { AtomicBatchRejected } from "../../src/shell/operations/contract";

const users = [
  "10000000-0000-4000-8000-000000000051",
  "10000000-0000-4000-8000-000000000052",
] as const;

const category = "10000000-0000-4000-8000-000000000016";

const sessions = [
  "10000000-0000-4000-8000-000000000061",
  "10000000-0000-4000-8000-000000000062",
] as const;

const bearer = (index: number): string => String(index + 1).repeat(43);

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const request = (
  index: number,
  path: string,
  ...args: [method?: string, body?: object]
): Request => {
  const [method = "GET", body] = args;

  const headers = {
    origin: "https://app.fidyapp.com",
    "Fidy-Session-Binding": sessions[index] ?? "invalid",
    cookie: `__Host-fidy_session=${bearer(index)}`,
  };

  return new Request(
    `https://api.fidyapp.com${path}`,
    body === undefined
      ? { method, headers }
      : {
          method,
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        }
  );
};

const seedMonthlyMovements = <Rows>(
  execute: (query: string, ...bindings: Array<string | number>) => Promise<Rows>,
  input: Readonly<{
    categoryId: string;
    currency: string;
    occurredAt: string;
    count: number;
    offset: number;
  }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.asVoid(
    Effect.tryPromise(() =>
      execute(
        `INSERT INTO transactions
    (id, user_id, amount, currency, direction, category_id, occurred_at_ms, created_at_ms)
    WITH RECURSIVE seq(n) AS (SELECT ? + 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
    SELECT printf('30000000-0000-4000-8000-%012d', n), ?, '0.01', ?, 'outflow', ?, CAST(round(unixepoch(?,'subsec')*1000) AS INTEGER),
      CAST(unixepoch(date('2024-01-01', '+' || (n / 99) || ' days'))*1000 AS INTEGER)
    FROM seq`,
        input.offset,
        input.offset + input.count,
        users[0],
        input.currency,
        input.categoryId,
        input.occurredAt
      )
    )
  );

const patRequest = (
  token: string,
  path: string,
  ...args: [method?: string, body?: object]
): Request => {
  const [method = "GET", body] = args;

  const headers = {
    origin: "https://app.fidyapp.com",
    authorization: `Bearer ${token}`,
    "x-provider-id": users[0],
  };

  return new Request(
    `https://api.fidyapp.com${path}`,
    body === undefined
      ? { method, headers }
      : {
          method,
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        }
  );
};

type BudgetPayload = Readonly<{
  categoryId: string;
  cap: Readonly<{ amount: string; currency: string }>;
}>;

type BudgetCall = Readonly<{ callId: string; operation: string; input: unknown }>;

const payload = (cap = "100"): BudgetPayload => ({
  categoryId: category,
  cap: { amount: cap, currency: "COP" },
});

const budgetBatch = (calls: ReadonlyArray<object>): Request =>
  request(0, "/operations/atomic-batch", "POST", { calls });

const budgetCall = (index: number, operation: string, input: unknown): BudgetCall => ({
  callId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  operation,
  input,
});

const Created = Schema.Struct({
  data: Schema.toCodecJson(Budget),
  next: Schema.Array(Schema.Unknown),
});

const Report = Schema.Struct({
  data: Schema.toCodecJson(BudgetStatusReport),
  next: Schema.Array(Schema.Unknown),
});

it("classifies a skipped Budget update after an earlier deletion as not_found without partial state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const createResponse5 = yield* Effect.tryPromise(() =>
        db.send(request(0, "/budgets", "POST", payload()))
      );

      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => createResponse5.json())
      );

      const refused = yield* Effect.tryPromise(() =>
        db.send(
          budgetBatch([
            budgetCall(1, "budgets.deleteBudget", { params: { id: created.data.id } }),
            budgetCall(2, "budgets.updateBudget", {
              params: { id: created.data.id },
              payload: payload("200"),
            }),
          ])
        )
      );

      expect(refused.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(AtomicBatchRejected)(
        yield* Effect.tryPromise(() => refused.json())
      );

      expect(rejection.error.code).toBe("not_found");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("budgets.updateBudget");
      expect(
        yield* Effect.tryPromise(() =>
          db.exec("SELECT cap FROM budgets WHERE id=?", created.data.id)
        )
      ).toEqual([{ cap: "100" }]);
      expect(
        yield* Effect.tryPromise(() =>
          db.exec(
            "SELECT outcome,count(*) AS n FROM audit_entries WHERE record_type='session_call' AND operation GLOB 'budgets.*' GROUP BY outcome ORDER BY outcome"
          )
        )
      ).toEqual([
        { outcome: "not_found", n: 1 },
        { outcome: "success", n: 1 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("creates a positive User-owned Budget and never reveals it to another User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const created = yield* Effect.tryPromise(() =>
        db.send(request(0, "/budgets", "POST", payload()))
      );

      expect(created.status).toBe(201);

      const body = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => created.json())
      );

      expect(encodeMoneyAmount(body.data.cap.amount)).toBe("100");

      const foreign = yield* Effect.tryPromise(() =>
        db.send(request(1, `/budgets/${body.data.id}`))
      );

      expect(foreign.status).toBe(404);
      const own = yield* Effect.tryPromise(() => db.send(request(0, `/budgets/${body.data.id}`)));
      expect(own.status).toBe(200);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("combines Category and Currency filters without including other Budgets or Users", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const otherCategory = "10000000-0000-4000-8000-000000000001";

      yield* Effect.forEach(
        [
          { categoryId: category, currency: "COP" },
          { categoryId: category, currency: "USD" },
          { categoryId: otherCategory, currency: "COP" },
        ],
        Effect.fnUntraced(function* ({ categoryId, currency }) {
          expect(
            (yield* Effect.tryPromise(() =>
              db.send(
                request(0, "/budgets", "POST", {
                  categoryId,
                  cap: { amount: "100", currency },
                })
              )
            )).status
          ).toBe(201);
        }),
        { discard: true }
      );

      const foreign = yield* Effect.tryPromise(() =>
        db.send(request(1, "/budgets", "POST", payload()))
      );

      expect(foreign.status).toBe(201);

      const foreignBudget = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => foreign.json())
      );

      yield* Effect.forEach(
        [
          { query: `categoryId=${category}`, expected: [`${category}:COP`, `${category}:USD`] },
          { query: "currency=COP", expected: [`${category}:COP`, `${otherCategory}:COP`] },
          { query: `categoryId=${category}&currency=COP`, expected: [`${category}:COP`] },
          { query: `categoryId=${otherCategory}&currency=USD`, expected: [] },
        ],
        Effect.fnUntraced(function* (selection) {
          const response = yield* Effect.tryPromise(() =>
            db.send(request(0, `/budget-status?timeZone=America%2FBogota&${selection.query}`))
          );

          expect(response.status).toBe(200);

          const report = yield* Schema.decodeUnknownEffect(Report)(
            yield* Effect.tryPromise(() => response.json())
          );

          expect(report.data.statuses.map(({ budget }) => budget.id)).not.toContain(
            foreignBudget.data.id
          );
          expect(
            report.data.statuses
              .map(({ budget }) => `${budget.categoryId}:${budget.cap.currency}`)
              .sort()
          ).toEqual(selection.expected.toSorted());
        }),
        { discard: true }
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("revises a Budget without changing Currency and deletes only its owner's Budget", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const createResponse7 = yield* Effect.tryPromise(() =>
        db.send(request(0, "/budgets", "POST", payload()))
      );

      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => createResponse7.json())
      );

      const id = created.data.id;

      const foreign = yield* Effect.tryPromise(() =>
        db.send(request(1, `/budgets/${id}`, "PUT", payload("200")))
      );

      expect(foreign.status).toBe(404);
      expect(
        (yield* Effect.tryPromise(() => db.send(request(1, `/budgets/${id}`, "DELETE")))).status
      ).toBe(404);

      const refused = yield* Effect.tryPromise(() =>
        db
          .owner(users[1])
          .exec(
            "SELECT operation,outcome FROM audit_entries WHERE record_type='session_call' AND operation GLOB 'budgets.*' ORDER BY operation"
          )
      );

      expect(refused).toEqual([
        { operation: "budgets.deleteBudget", outcome: "not_found" },
        { operation: "budgets.updateBudget", outcome: "not_found" },
      ]);
      expect((yield* Effect.tryPromise(() => db.send(request(0, `/budgets/${id}`)))).status).toBe(
        200
      );
      expect(
        (yield* Effect.tryPromise(() => db.send(request(0, "/budgets/not-a-budget", "DELETE"))))
          .status
      ).toBe(404);
      expect(
        (yield* Effect.tryPromise(() =>
          db.send(
            request(0, "/budgets", "POST", {
              categoryId: category,
              cap: { amount: "-1", currency: "COP" },
            })
          )
        )).status
      ).toBe(400);
      expect(
        (yield* Effect.tryPromise(() => db.send(request(0, "/budget-status?timeZone=not-a-zone"))))
          .status
      ).toBe(400);

      const invalidAudits = yield* Effect.tryPromise(() =>
        db.exec(
          "SELECT operation FROM audit_entries WHERE record_type='session_call' AND operation GLOB 'budgets.*' AND outcome IN ('validation_failed','not_found') ORDER BY operation"
        )
      );

      expect(invalidAudits.map((row) => row.operation)).toEqual([
        "budgets.createBudget",
        "budgets.deleteBudget",
        "budgets.getBudgetStatus",
      ]);

      const wrongCurrency = yield* Effect.tryPromise(() =>
        db.send(
          request(0, `/budgets/${id}`, "PUT", {
            categoryId: category,
            cap: { amount: "200", currency: "USD" },
          })
        )
      );

      expect(wrongCurrency.status).toBe(400);

      const duplicate = yield* Effect.tryPromise(() =>
        db.send(request(0, "/budgets", "POST", payload("300")))
      );

      expect(duplicate.status).toBe(400);

      const updated = yield* Effect.tryPromise(() =>
        db.send(request(0, `/budgets/${id}`, "PUT", payload("250.25")))
      );

      expect(updated.status).toBe(200);

      const changed = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => updated.json())
      );

      expect(encodeMoneyAmount(changed.data.cap.amount)).toBe("250.25");
      expect(
        (yield* Effect.tryPromise(() => db.send(request(0, `/budgets/${id}`, "DELETE")))).status
      ).toBe(200);
      expect((yield* Effect.tryPromise(() => db.send(request(0, `/budgets/${id}`)))).status).toBe(
        404
      );
      expect(
        (yield* Effect.tryPromise(() => db.send(request(1, "/budgets", "POST", payload())))).status
      ).toBe(201);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("reads back Budget creation, replacement and removal through the atomic batch without leaking a foreign Budget", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const call = (operation: string, input: unknown, index: number): BudgetCall => ({
        callId: `30000000-0000-4000-8000-00000000000${index}`,
        operation,
        input,
      });

      const batch = (calls: ReadonlyArray<object>): Promise<Response> =>
        db.send(request(0, "/operations/atomic-batch", "POST", { calls }));

      const created = yield* Effect.tryPromise(() =>
        batch([call("budgets.createBudget", { payload: payload() }, 1)])
      );

      expect(created.status).toBe(200);
      const result = yield* Effect.tryPromise(() => created.json());

      const id = (yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Schema.Struct({
            results: Schema.Array(
              Schema.Struct({
                output: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
              })
            ),
          }),
        })
      )(result)).data.results[0]?.output.data.id;

      expect(id).toBeDefined();

      const changed = yield* Effect.tryPromise(() =>
        batch([
          call(
            "budgets.updateBudget",
            {
              params: { id },
              payload: payload("250.25"),
            },
            2
          ),
        ])
      );

      expect(changed.status).toBe(200);

      const updated = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Schema.Struct({
            results: Schema.Array(
              Schema.Struct({
                output: Schema.Struct({ data: Schema.toCodecJson(Budget) }),
              })
            ),
          }),
        })
      )(yield* Effect.tryPromise(() => changed.json()));

      const first = updated.data.results[0];

      if (first === undefined) throw new Error("Missing batch Budget result");
      expect(encodeMoneyAmount(first.output.data.cap.amount)).toBe("250.25");
      const foreign = yield* Effect.tryPromise(() => db.send(request(1, `/budgets/${id}`)));
      expect(foreign.status).toBe(404);

      const removed = yield* Effect.tryPromise(() =>
        batch([call("budgets.deleteBudget", { params: { id } }, 3)])
      );

      expect(removed.status).toBe(200);
      expect(yield* Effect.tryPromise(() => removed.json())).toMatchObject({
        data: { results: [{ output: { data: id } }] },
      });
      expect((yield* Effect.tryPromise(() => db.send(request(0, `/budgets/${id}`)))).status).toBe(
        404
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("reports only this User's exact same-Currency outflows in the applied half-open month", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      expect(
        (yield* Effect.tryPromise(() => db.send(request(0, "/budgets", "POST", payload())))).status
      ).toBe(201);

      const period = deriveCurrentBudgetMonth({
        now: DateTime.nowUnsafe(),
        timeZone: IanaTimeZone.make("America/Bogota"),
      });

      const capture = (
        index: number,
        amount: string,
        ...args: [currency: string, direction: string, occurredAt: string]
      ): Promise<Response> => {
        const [currency, direction, occurredAt] = args;

        return db.send(
          request(index, "/transactions", "POST", {
            money: { amount, currency },
            categoryId: category,
            direction,
            occurredAt,
          })
        );
      };

      expect(
        (yield* Effect.tryPromise(() =>
          capture(0, "80.01", "COP", "outflow", DateTime.formatIso(period.from))
        )).status
      ).toBe(201);
      expect(
        (yield* Effect.tryPromise(() =>
          capture(0, "19.98", "COP", "outflow", DateTime.formatIso(period.from))
        )).status
      ).toBe(201);
      expect(
        (yield* Effect.tryPromise(() =>
          capture(0, "5", "USD", "outflow", DateTime.formatIso(period.from))
        )).status
      ).toBe(201);
      expect(
        (yield* Effect.tryPromise(() =>
          capture(0, "5", "COP", "inflow", DateTime.formatIso(period.from))
        )).status
      ).toBe(201);
      expect(
        (yield* Effect.tryPromise(() =>
          capture(1, "5", "COP", "outflow", DateTime.formatIso(period.from))
        )).status
      ).toBe(201);
      const before = DateTime.makeUnsafe(period.from.epochMilliseconds - 1);
      expect(
        (yield* Effect.tryPromise(() =>
          capture(0, "5", "COP", "outflow", DateTime.formatIso(before))
        )).status
      ).toBe(201);
      yield* Effect.tryPromise(() =>
        db.exec(
          `INSERT INTO transactions
    (id, user_id, amount, currency, direction, category_id, occurred_at_ms, created_at_ms)
    VALUES (?, ?, '900', 'COP', 'outflow', ?,CAST(round(unixepoch(?,'subsec')*1000) AS INTEGER),CAST(round(unixepoch(?,'subsec')*1000) AS INTEGER))`,
          "30000000-0000-4000-8000-000000000093",
          users[0],
          category,
          DateTime.formatIso(period.to),
          DateTime.formatIso(DateTime.nowUnsafe())
        )
      );

      const response = yield* Effect.tryPromise(() =>
        db.send(request(0, "/budget-status?timeZone=America%2FBogota"))
      );

      expect(response.status).toBe(200);
      const workspace = yield* Effect.tryPromise(() => response.clone().json());
      expect(workspace).toMatchObject({
        data: { budgets: [expect.objectContaining({ categoryId: category })] },
      });

      const report = yield* Schema.decodeUnknownEffect(Report)(
        yield* Effect.tryPromise(() => response.json())
      );

      expect(report.data.statuses).toHaveLength(1);
      const [first] = report.data.statuses;

      if (first === undefined) throw new Error("Budget status missing");
      expect(encodeMoneyAmount(first.spent.amount)).toBe("99.99");

      const other = yield* Effect.tryPromise(() =>
        db.send(request(1, "/budget-status?timeZone=America%2FBogota"))
      );

      expect(other.status).toBe(200);
      expect(
        (yield* Schema.decodeUnknownEffect(Report)(yield* Effect.tryPromise(() => other.json())))
          .data.statuses
      ).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("returns complete exact spending for multiple Budgets in the first request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const otherCategory = "10000000-0000-4000-8000-000000000001";
      expect(
        (yield* Effect.tryPromise(() => db.send(request(0, "/budgets", "POST", payload())))).status
      ).toBe(201);
      expect(
        (yield* Effect.tryPromise(() =>
          db.send(
            request(0, "/budgets", "POST", {
              categoryId: otherCategory,
              cap: { amount: "100", currency: "COP" },
            })
          )
        )).status
      ).toBe(201);
      const occurredAt = DateTime.formatIso(DateTime.nowUnsafe());
      yield* seedMonthlyMovements(db.exec, {
        categoryId: category,
        currency: "COP",
        count: 2500,
        offset: 0,
        occurredAt,
      });
      yield* seedMonthlyMovements(db.exec, {
        categoryId: otherCategory,
        currency: "COP",
        count: 2500,
        offset: 2500,
        occurredAt,
      });

      const report = yield* Effect.tryPromise(() =>
        db.send(request(0, "/budget-status?timeZone=America%2FBogota"))
      );

      expect(report.status).toBe(200);

      const statuses = (yield* Schema.decodeUnknownEffect(Report)(
        yield* Effect.tryPromise(() => report.json())
      )).data.statuses;

      expect(statuses.map((status) => encodeMoneyAmount(status.spent.amount))).toEqual([
        "25",
        "25",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("denies read-scoped PAT writes and write-scoped PAT reads without disclosure or mutation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const readToken = `fin_${"r".repeat(8)}_${"a".repeat(43)}`;
      const writeToken = `fin_${"w".repeat(8)}_${"b".repeat(43)}`;
      yield* seedNativePAT({
        db,
        userId: users[0],
        current: DateTime.nowUnsafe().epochMilliseconds,
        token: readToken,
        scopes: ["read"],
      });
      yield* seedNativePAT({
        db,
        userId: users[0],
        current: DateTime.nowUnsafe().epochMilliseconds,
        token: writeToken,
        scopes: ["write"],
      });
      expect(
        (yield* Effect.tryPromise(() =>
          db.send(patRequest(readToken, "/budgets", "POST", payload()))
        )).status
      ).toBe(403);

      const created = yield* Effect.tryPromise(() =>
        db.send(request(0, "/budgets", "POST", payload()))
      );

      expect(created.status).toBe(201);

      const owner = (yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => created.json())
      )).data;

      expect(
        (yield* Effect.tryPromise(() =>
          db.send(patRequest(readToken, `/budgets/${owner.id}`, "DELETE"))
        )).status
      ).toBe(403);

      const denied = yield* Effect.tryPromise(() =>
        db.send(patRequest(writeToken, `/budgets/${owner.id}`))
      );

      expect(denied.status).toBe(403);
      expect(
        (yield* Effect.tryPromise(() =>
          db.send(patRequest(writeToken, "/budget-status?timeZone=America%2FBogota"))
        )).status
      ).toBe(403);
      expect(
        (yield* Effect.tryPromise(() => db.send(request(0, `/budgets/${owner.id}`)))).status
      ).toBe(200);

      const count = yield* Effect.tryPromise(() =>
        db.exec("SELECT count(*) AS count FROM budgets WHERE user_id=?", users[0])
      );

      expect(count[0]?.count).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("exposes spending without a matching Category and Currency cap in the monthly report", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      expect(
        (yield* Effect.tryPromise(() => db.send(request(0, "/budgets", "POST", payload("10000")))))
          .status
      ).toBe(201);
      const unbudgetedCategory = "10000000-0000-4000-8000-000000000015";

      yield* Effect.forEach(
        [
          [0, category, "20000", "COP", "outflow"],
          [0, unbudgetedCategory, "5000", "COP", "outflow"],
          [0, category, "7.25", "USD", "outflow"],
          [0, unbudgetedCategory, "90000", "COP", "inflow"],
          [1, unbudgetedCategory, "999", "COP", "outflow"],
        ] as const,
        Effect.fnUntraced(function* ([index, categoryId, amount, currency, direction]) {
          expect(
            (yield* Effect.tryPromise(() =>
              db.send(
                request(index, "/transactions", "POST", {
                  money: { amount, currency },
                  categoryId,
                  direction,
                  occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
                })
              )
            )).status
          ).toBe(201);
        }),
        { discard: true }
      );

      const response = yield* Effect.tryPromise(() =>
        db.send(request(0, "/budget-status?timeZone=America%2FBogota"))
      );

      expect(response.status).toBe(200);
      expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
        data: {
          unbudgetedExpenses: [
            { categoryId: unbudgetedCategory, spent: { amount: "5000", currency: "COP" } },
            { categoryId: category, spent: { amount: "7.25", currency: "USD" } },
          ],
        },
      });

      const filtered = yield* Effect.tryPromise(() =>
        db.send(
          request(0, `/budget-status?timeZone=America%2FBogota&categoryId=${category}&currency=COP`)
        )
      );

      expect(yield* Effect.tryPromise(() => filtered.json())).toMatchObject({
        data: { unbudgetedExpenses: [] },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("freezes monthly plans, inherits forward without rollover, and isolates owners", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const response = yield* Effect.tryPromise(() =>
        db.send(
          request(0, "/budgets", "POST", { ...payload(), month: "2026-10", groupName: "Hogar" })
        )
      );

      expect(response.status).toBe(201);

      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => response.json())
      );

      const report = (
        month: string,
        owner = 0
      ): Effect.Effect<BudgetStatusReport, Cause.UnknownError | Schema.SchemaError> =>
        Effect.gen(function* () {
          const res = yield* Effect.tryPromise(() =>
            db.send(request(owner, `/budget-status?timeZone=America%2FBogota&month=${month}`))
          );

          expect(res.status).toBe(200);

          return (yield* Schema.decodeUnknownEffect(Report)(
            yield* Effect.tryPromise(() => res.json())
          )).data;
        });

      const preview = yield* report("2026-11");
      expect(preview.initialized).toBe(false);
      expect(
        encodeMoneyAmount(Option.getOrThrow(EffectArray.head(preview.statuses)).budget.cap.amount)
      ).toBe("100");

      yield* Effect.forEach(
        [
          ["2026-11", "200"],
          ["2026-10", "50"],
        ],
        Effect.fnUntraced(function* ([month, cap]) {
          const saved = yield* Effect.tryPromise(() =>
            db.send(request(0, `/budgets/${created.data.id}`, "PUT", { ...payload(cap), month }))
          );

          expect(saved.status).toBe(200);
          expect(
            encodeMoneyAmount(
              (yield* Schema.decodeUnknownEffect(Created)(
                yield* Effect.tryPromise(() => saved.json())
              )).data.cap.amount
            )
          ).toBe(cap);
        }),
        { discard: true }
      );

      expect(
        encodeMoneyAmount(
          Option.getOrThrow(EffectArray.head((yield* report("2026-10")).statuses)).budget.cap.amount
        )
      ).toBe("50");
      const november = yield* report("2026-11");
      expect(november.initialized).toBe(true);
      expect(
        encodeMoneyAmount(Option.getOrThrow(EffectArray.head(november.statuses)).budget.cap.amount)
      ).toBe("200");
      expect(
        encodeMoneyAmount(
          Option.getOrThrow(EffectArray.head((yield* report("2026-12")).statuses)).budget.cap.amount
        )
      ).toBe("200");
      expect((yield* report("2026-09")).statuses).toEqual([]);
      expect((yield* report("2026-11", 1)).statuses).toEqual([]);
      yield* Effect.sleep("250 millis");

      const renamed = yield* Effect.tryPromise(() =>
        db.send(
          request(0, `/budgets/${created.data.id}`, "PUT", {
            ...payload("200"),
            month: "2026-11",
            groupName: "Casa",
            groupCategoryIds: [category],
          })
        )
      );

      expect(renamed.status).toBe(200);
      expect(
        Option.getOrThrow(EffectArray.head((yield* report("2026-10")).statuses)).budget.groupName
      ).toBe("Casa");
      expect(
        (yield* Effect.tryPromise(() =>
          db.send(request(0, "/budget-status?timeZone=America%2FBogota&month=2026-13"))
        )).status
      ).toBe(400);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

const groupCurrenciesAt = (
  db: Effect.Success<typeof nativeTransactionJourney>,
  month: string,
  owner = 0
): Effect.Effect<ReadonlyArray<string>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() =>
      db.send(request(owner, `/budget-status?timeZone=America%2FBogota&month=${month}`))
    );

    const report = yield* Schema.decodeUnknownEffect(Schema.Struct({ data: BudgetStatusReport }))(
      yield* Effect.tryPromise(() => response.json())
    );

    return report.data.statuses.map((status) => status.budget.cap.currency);
  });

it("versions currency for every group member without changing earlier months or another owner", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const response = yield* Effect.tryPromise(() =>
        db.send(
          request(0, "/budgets", "POST", { ...payload(), month: "2026-10", groupName: "Hogar" })
        )
      );

      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => response.json())
      );

      const second = "10000000-0000-4000-8000-000000000012";
      expect(
        (yield* Effect.tryPromise(() =>
          db.send(
            request(0, "/budgets", "POST", {
              categoryId: second,
              cap: { amount: "250", currency: "COP" },
              month: "2026-10",
              groupName: "Hogar",
            })
          )
        )).status
      ).toBe(201);
      expect(
        (yield* Effect.tryPromise(() =>
          db.send(
            request(1, "/budgets", "POST", { ...payload(), month: "2026-10", groupName: "Hogar" })
          )
        )).status
      ).toBe(201);
      expect(
        (yield* Effect.tryPromise(() =>
          db.send(
            request(0, `/budgets/${created.data.id}`, "PUT", {
              ...payload(),
              month: "2026-11",
              groupName: "Hogar",
              groupCategoryIds: [category, second],
              groupCurrency: "USD",
            })
          )
        )).status
      ).toBe(200);
      expect(yield* groupCurrenciesAt(db, "2026-10")).toEqual(["COP", "COP"]);
      expect(yield* groupCurrenciesAt(db, "2026-11")).toEqual(["USD", "USD"]);
      expect(yield* groupCurrenciesAt(db, "2026-12")).toEqual(["USD", "USD"]);
      expect((yield* groupCurrenciesAt(db, "2026-11", 1))[0]).toBe("COP");

      const staleGroup = yield* Effect.tryPromise(() =>
        db.send(
          request(0, `/budgets/${created.data.id}`, "PUT", {
            ...payload(),
            month: "2026-11",
            groupName: "Borrador",
            groupCategoryIds: [category, second],
            groupCurrency: "COP",
          })
        )
      );

      expect(staleGroup.status).toBe(400);
      expect(yield* Effect.tryPromise(() => staleGroup.json())).toMatchObject({
        error: { code: "validation_failed", fields: [{ path: "cap.currency" }] },
      });
      expect(yield* groupCurrenciesAt(db, "2026-11")).toEqual(["USD", "USD"]);

      yield* Effect.forEach(
        ["2026-10", "2026-11"],
        Effect.fnUntraced(function* (month) {
          const duplicate = yield* Effect.tryPromise(() =>
            db.send(
              request(0, "/budgets", "POST", {
                categoryId: second,
                cap: { amount: "100", currency: "USD" },
                month,
              })
            )
          );

          expect(duplicate.status).toBe(400);
        }),
        { discard: true }
      );

      expect(
        (yield* Effect.tryPromise(() =>
          db.send(
            request(0, `/budgets/${created.data.id}`, "PUT", {
              categoryId: category,
              cap: { amount: "100", currency: "EUR" },
              month: "2026-11",
              groupName: "Hogar",
            })
          )
        )).status
      ).toBe(400);
      expect(yield* groupCurrenciesAt(db, "2026-11")).toEqual(["USD", "USD"]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it.each(["2026-09", "2026-12"])(
  "refuses group currency precision loss from a member cap saved in %s",
  (capMonth) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney;

        const response = yield* Effect.tryPromise(() =>
          db.send(
            request(0, "/budgets", "POST", {
              categoryId: category,
              cap: { amount: "100", currency: "USD" },
              month: "2026-08",
              groupName: "Hogar",
            })
          )
        );

        const created = yield* Schema.decodeUnknownEffect(Created)(
          yield* Effect.tryPromise(() => response.json())
        );

        const second = "10000000-0000-4000-8000-000000000012";

        const other = yield* Effect.tryPromise(() =>
          db.send(
            request(0, "/budgets", "POST", {
              categoryId: second,
              cap: { amount: "50", currency: "USD" },
              month: "2026-08",
              groupName: "Hogar",
            })
          )
        );

        const member = yield* Schema.decodeUnknownEffect(Created)(
          yield* Effect.tryPromise(() => other.json())
        );

        expect(
          (yield* Effect.tryPromise(() =>
            db.send(
              request(0, `/budgets/${member.data.id}`, "PUT", {
                categoryId: second,
                cap: { amount: "10.25", currency: "USD" },
                month: capMonth,
                groupName: "Hogar",
              })
            )
          )).status
        ).toBe(200);
        expect(
          (yield* Effect.tryPromise(() =>
            db.send(
              request(0, `/budgets/${created.data.id}`, "PUT", {
                categoryId: category,
                cap: { amount: "100", currency: "USD" },
                month: "2026-11",
                groupName: "Hogar",
                groupCategoryIds: [category, second],
                groupCurrency: "JPY",
              })
            )
          )).status
        ).toBe(400);
        expect(yield* groupCurrenciesAt(db, "2026-11")).toEqual(["USD", "USD"]);
        expect(
          yield* Effect.tryPromise(() =>
            db.exec(
              "SELECT 1 FROM budget_month_plan_records WHERE kind='plan' AND user_id=? AND month='2026-11'",
              users[0]
            )
          )
        ).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
    )
);
