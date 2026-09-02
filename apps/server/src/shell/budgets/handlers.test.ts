import { expect, layer } from "@effect/vitest";
import { BigDecimal, DateTime, Effect, Equal, Option, Result, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import { IanaTimeZone } from "~/core/_shared/context";
import { Currency, Money } from "~/core/_shared/money";
import { BudgetId } from "~/core/budgets/reference";
import { deriveCurrentBudgetMonth } from "~/core/budgets/rules";
import { categoryIds } from "~/core/categories/taxonomy";
import { MigrationSqlClient } from "~/shell/db/client";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";
import { transactionPayload, truncateTransactions } from "~/shell/transactions/fixtures";

const cap = (amount: string, currency: Currency = Currency.make("COP")): Money =>
  Money.make({ amount: BigDecimal.fromStringUnsafe(amount), currency });

const resetBudgets = Effect.gen(function* () {
  yield* truncateTransactions;
  const sql = yield* MigrationSqlClient;
  yield* sql`TRUNCATE budget_month_latches, budgets`;
});

const LatchFlags = Schema.Struct({
  reached80: Schema.Boolean,
  reached100: Schema.Boolean,
});
const loadLatchFlags = Effect.fn("loadLatchFlags")(function* (budgetId: BudgetId) {
  const sql = yield* MigrationSqlClient;
  return yield* SqlSchema.findAll({
    Request: BudgetId,
    Result: LatchFlags,
    execute: (id) => sql`SELECT reached_80 AS "reached80", reached_100 AS "reached100"
      FROM budget_month_latches WHERE budget_id = ${id}`,
  })(budgetId);
});

const loadLatchCount = Effect.fn("loadLatchCount")(function* (budgetId: BudgetId) {
  const sql = yield* MigrationSqlClient;
  return yield* SqlSchema.findOne({
    Request: BudgetId,
    Result: Schema.Struct({ count: Schema.FiniteFromString }),
    execute: (id) => sql`SELECT count(*)::text AS count FROM budget_month_latches
      WHERE budget_id = ${id}`,
  })(budgetId);
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "budget operations",
  (it) => {
    it.effect(
      "creates, deterministically lists, reads, updates, and physically deletes a Budget",
      () =>
        Effect.gen(function* () {
          yield* resetBudgets;
          const client = yield* ApiHarnessClient;

          const created = yield* client.budgets.createBudget({
            payload: {
              categoryId: categoryIds.restaurantes,
              cap: cap("1000000"),
            },
          });
          const usd = yield* client.budgets.createBudget({
            payload: {
              categoryId: categoryIds.mercado,
              cap: cap("500", Currency.make("USD")),
            },
          });
          const listed = yield* client.budgets.listBudgets();
          const read = yield* client.budgets.getBudget({
            params: { id: created.data.id },
          });
          const updated = yield* client.budgets.updateBudget({
            params: { id: created.data.id },
            payload: { categoryId: categoryIds.mercado, cap: cap("1200000") },
          });
          const deleted = yield* client.budgets.deleteBudget({
            params: { id: created.data.id },
          });
          const afterDelete = yield* client.budgets.listBudgets();

          expect(listed.data.map(({ id }) => id)).toEqual([created.data.id, usd.data.id]);
          expect(read.data.id).toBe(created.data.id);
          expect(Equal.equals(read.data.cap.amount, created.data.cap.amount)).toBe(true);
          expect(updated.data.id).toBe(created.data.id);
          expect(updated.data.categoryId).toBe(categoryIds.mercado);
          expect(Equal.equals(updated.data.cap.amount, cap("1200000").amount)).toBe(true);
          expect(updated.data.cap.currency).toBe("COP");
          expect(deleted.data).toBe(created.data.id);
          expect(afterDelete.data.map(({ id }) => id)).toEqual([usd.data.id]);
        })
    );

    it.effect("counts a linked Transaction pair once and restores both after unlinking", () =>
      Effect.gen(function* () {
        yield* resetBudgets;
        const client = yield* ApiHarnessClient;
        const timeZone = IanaTimeZone.make("America/Bogota");
        const occurredAt = yield* DateTime.now;
        yield* client.budgets.createBudget({
          payload: { categoryId: categoryIds.restaurantes, cap: cap("100000") },
        });
        const first = yield* client.transactions.createTransaction({
          payload: transactionPayload({ occurredAt }),
        });
        const second = yield* client.transactions.createTransaction({
          payload: transactionPayload({ occurredAt }),
        });
        const pair = {
          firstTransactionId: first.data.id,
          secondTransactionId: second.data.id,
        };

        yield* client.transactions.linkTransactions({ payload: pair });
        const linked = yield* client.budgets.getBudgetStatus({ query: { timeZone } });
        yield* client.transactions.unlinkTransactions({ payload: pair });
        const restored = yield* client.budgets.getBudgetStatus({ query: { timeZone } });

        expect(Equal.equals(linked.data.statuses[0]?.spent.amount, cap("25000").amount)).toBe(true);
        expect(Equal.equals(restored.data.statuses[0]?.spent.amount, cap("50000").amount)).toBe(
          true
        );
      })
    );

    it.effect(
      "rejects non-positive caps, duplicate Category/Currency scopes, and Currency edits",
      () =>
        Effect.gen(function* () {
          yield* resetBudgets;
          const client = yield* ApiHarnessClient;
          const created = yield* client.budgets.createBudget({
            payload: { categoryId: categoryIds.restaurantes, cap: cap("100") },
          });

          const duplicate = yield* Effect.result(
            client.budgets.createBudget({
              payload: {
                categoryId: categoryIds.restaurantes,
                cap: cap("200"),
              },
            })
          );
          const currencyEdit = yield* Effect.result(
            client.budgets.updateBudget({
              params: { id: created.data.id },
              payload: {
                categoryId: categoryIds.restaurantes,
                cap: cap("100", Currency.make("USD")),
              },
            })
          );
          const zeroCap = yield* Effect.result(
            client.budgets.createBudget({
              payload: { categoryId: categoryIds.mercado, cap: cap("0") },
            })
          );
          const retained = yield* client.budgets.listBudgets();
          const latches = yield* loadLatchFlags(created.data.id);

          expect(duplicate).toMatchObject({
            _tag: "Failure",
            failure: { error: { code: "validation_failed" } },
          });
          expect(currencyEdit).toMatchObject({
            _tag: "Failure",
            failure: { error: { code: "validation_failed" } },
          });
          expect(Result.isFailure(zeroCap)).toBe(true);
          expect(retained.data.map(({ id }) => id)).toEqual([created.data.id]);
          expect(Equal.equals(retained.data[0]?.cap.amount, created.data.cap.amount)).toBe(true);
          expect(latches).toEqual([{ reached80: false, reached100: false }]);
        })
    );

    it.effect("calculates exact current-month status by Category and Currency without FX", () =>
      Effect.gen(function* () {
        yield* resetBudgets;
        const client = yield* ApiHarnessClient;
        const zone = IanaTimeZone.make("America/New_York");
        const now = yield* DateTime.now;
        const period = deriveCurrentBudgetMonth({ now, timeZone: zone });
        const inMonth = now;
        const copRestaurant = yield* client.budgets.createBudget({
          payload: { categoryId: categoryIds.restaurantes, cap: cap("100") },
        });
        const usdRestaurant = yield* client.budgets.createBudget({
          payload: {
            categoryId: categoryIds.restaurantes,
            cap: cap("50", Currency.make("USD")),
          },
        });
        const copMarket = yield* client.budgets.createBudget({
          payload: { categoryId: categoryIds.mercado, cap: cap("200") },
        });

        yield* client.transactions.createTransaction({
          payload: transactionPayload({
            money: cap("80"),
            categoryId: Option.some(categoryIds.restaurantes),
            occurredAt: inMonth,
          }),
        });
        yield* client.transactions.createTransaction({
          payload: transactionPayload({
            money: cap("60", Currency.make("USD")),
            categoryId: Option.some(categoryIds.restaurantes),
            occurredAt: inMonth,
          }),
        });
        yield* client.transactions.createTransaction({
          payload: transactionPayload({
            money: cap("999"),
            direction: "inflow",
            categoryId: Option.some(categoryIds.mercado),
            occurredAt: inMonth,
          }),
        });
        yield* client.transactions.createTransaction({
          payload: transactionPayload({
            money: cap("1000"),
            categoryId: Option.some(categoryIds.restaurantes),
            occurredAt: DateTime.subtract(period.from, { seconds: 1 }),
          }),
        });

        const all = yield* client.budgets.getBudgetStatus({
          query: { timeZone: zone },
        });
        const usdOnly = yield* client.budgets.getBudgetStatus({
          query: { currency: Currency.make("USD"), timeZone: zone },
        });
        const combined = yield* client.budgets.getBudgetStatus({
          query: {
            categoryId: categoryIds.restaurantes,
            currency: Currency.make("COP"),
            timeZone: zone,
          },
        });

        expect(all.data.statuses.map((status) => status.budget.id)).toEqual([
          copRestaurant.data.id,
          copMarket.data.id,
          usdRestaurant.data.id,
        ]);
        expect(all.data.statuses.map(({ type }) => type)).toEqual(["under", "under", "over"]);
        expect(Equal.equals(all.data.statuses[0]?.spent.amount, cap("80").amount)).toBe(true);
        expect(Equal.equals(all.data.statuses[1]?.spent.amount, cap("0").amount)).toBe(true);
        expect(
          Equal.equals(all.data.statuses[2]?.spent.amount, cap("60", Currency.make("USD")).amount)
        ).toBe(true);
        expect(all.data.statuses.every((status) => status.period.timeZone === zone)).toBe(true);
        expect(all.data.period.timeZone).toBe(zone);
        expect(usdOnly.data.statuses.map((status) => status.budget.id)).toEqual([
          usdRestaurant.data.id,
        ]);
        expect(combined.data.statuses.map((status) => status.budget.id)).toEqual([
          copRestaurant.data.id,
        ]);
      })
    );

    it.effect(
      "initializes, preserves, resets, reads without advancing, and cascades monthly latches",
      () =>
        Effect.gen(function* () {
          yield* resetBudgets;
          const client = yield* ApiHarnessClient;
          const sql = yield* MigrationSqlClient;
          const created = yield* client.budgets.createBudget({
            payload: { categoryId: categoryIds.restaurantes, cap: cap("100") },
          });

          yield* sql`
          UPDATE budget_month_latches SET reached_80 = true, reached_100 = true
          WHERE budget_id = ${created.data.id}
        `;
          yield* client.budgets.getBudgetStatus({
            query: { timeZone: IanaTimeZone.make("Asia/Tokyo") },
          });
          yield* client.budgets.updateBudget({
            params: { id: created.data.id },
            payload: { categoryId: categoryIds.restaurantes, cap: cap("120") },
          });
          const preserved = yield* loadLatchFlags(created.data.id);

          yield* client.budgets.updateBudget({
            params: { id: created.data.id },
            payload: { categoryId: categoryIds.mercado, cap: cap("120") },
          });
          const reset = yield* loadLatchFlags(created.data.id);

          yield* client.budgets.deleteBudget({
            params: { id: created.data.id },
          });
          const afterDelete = yield* loadLatchCount(created.data.id);

          expect(preserved).toEqual([{ reached80: true, reached100: true }]);
          expect(reset).toEqual([{ reached80: false, reached100: false }]);
          expect(afterDelete).toEqual({ count: 0 });
        })
    );
  }
);
