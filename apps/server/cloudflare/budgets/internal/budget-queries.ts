import { type BudgetQueryOperation } from "../contract";
import {
  type Budget,
  BudgetId,
  BudgetStatusQueryParameters,
  type BudgetStatusReport,
} from "../../../src/core/budgets/contract";
import { Money } from "../../../src/core/_shared/money";
import { sumBudgetContributions } from "../../../src/core/budgets/operations";
import { BigDecimal, DateTime, Effect, Option, Ref, Schema } from "effect";
import { readBudgetContributions } from "../../transactions/operations";
import {
  type BudgetProgress,
  type BudgetProgressKey,
  advanceBudgetProgress,
  findBudgetProgress,
  findBudgetRevision,
} from "./budget-progress";

export const monthlySpent = ({
  db,
  userId,
  budget,
  period,
  pageQuota,
}: Readonly<{
  db: D1Database;
  userId: string;
  budget: Budget;
  period: BudgetStatusReport["period"];
  pageQuota: Ref.Ref<number>;
}>): Effect.Effect<Option.Option<Money>> =>
  Effect.gen(function* () {
    const key = { db, userId, budget, period };
    const revision = yield* findBudgetRevision(key);
    if (Option.isNone(revision)) return Option.none<Money>();
    const stored = yield* findBudgetProgress(key);
    let progress = Option.getOrElse(
      Option.filter(stored, (saved) => saved.revision === revision.value),
      () => ({
        revision: revision.value,
        cursorAt: DateTime.formatIso(period.from),
        cursorId: "",
        spent: Money.make({ amount: BigDecimal.make(0n, 0), currency: budget.cap.currency }),
        complete: false,
      })
    );
    // Persist each bounded page; later calls resume rather than replaying an oversized month.
    while (!progress.complete) {
      const available = yield* Ref.getAndUpdate(pageQuota, (remaining) =>
        Math.max(0, remaining - 1)
      );
      if (available === 0) return Option.none<Money>();
      const next = yield* advanceMonthlyPage({ key, progress });
      if (Option.isNone(next)) return Option.none<Money>();
      progress = next.value;
    }
    const current = yield* findBudgetRevision(key);
    return Option.isSome(current) && current.value === revision.value
      ? Option.some(progress.spent)
      : Option.none<Money>();
  }).pipe(Effect.orElseSucceed(() => Option.none()));

const advanceMonthlyPage = ({
  key,
  progress,
}: Readonly<{ key: BudgetProgressKey; progress: BudgetProgress }>): Effect.Effect<
  Option.Option<BudgetProgress>
> =>
  Effect.gen(function* () {
    const page = yield* readBudgetContributions({
      db: key.db,
      userId: key.userId,
      categoryId: key.budget.categoryId,
      currency: key.budget.cap.currency,
      period: key.period,
      cursor: { occurredAt: progress.cursorAt, transactionId: progress.cursorId },
    });
    if (Option.isNone(page)) return Option.none<BudgetProgress>();
    const pageSpent = sumBudgetContributions({
      budget: key.budget,
      period: key.period,
      movements: page.value.movements,
    });
    const next = {
      revision: progress.revision,
      cursorAt: page.value.cursor.occurredAt,
      cursorId: page.value.cursor.transactionId,
      spent: Money.make({
        amount: BigDecimal.sum(progress.spent.amount, pageSpent.amount),
        currency: key.budget.cap.currency,
      }),
      complete: page.value.complete,
    };
    return (yield* advanceBudgetProgress({ key, previous: progress, next }))
      ? Option.some(next)
      : Option.none<BudgetProgress>();
  });

const statusParameters = (url: URL): Option.Option<typeof BudgetStatusQueryParameters.Type> => {
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== new Set(keys).size ||
    keys.some((key) => !["categoryId", "currency", "timeZone"].includes(key))
  ) {
    return Option.none();
  }
  return Schema.decodeUnknownOption(BudgetStatusQueryParameters)(
    Object.fromEntries(url.searchParams)
  );
};

export const budgetParameters = ({
  operation,
  url,
}: Readonly<{ operation: BudgetQueryOperation; url: URL }>): Option.Option<{
  id: Option.Option<BudgetId>;
  query: Option.Option<typeof BudgetStatusQueryParameters.Type>;
}> => {
  if (operation === "budgets.getBudget") {
    if (url.searchParams.size > 0) return Option.none();
    const id = Schema.decodeOption(BudgetId)(url.pathname.split("/").at(-1) ?? "");
    return Option.isSome(id) ? Option.some({ id, query: Option.none() }) : Option.none();
  }
  if (operation === "budgets.listBudgets") {
    return url.searchParams.size === 0
      ? Option.some({ id: Option.none(), query: Option.none() })
      : Option.none();
  }
  return Option.map(statusParameters(url), (query) => ({
    id: Option.none<BudgetId>(),
    query: Option.some(query),
  }));
};
