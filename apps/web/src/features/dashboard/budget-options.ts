import type { CanonicalSuccess } from "@/transport/client";
import type { BudgetTarget } from "./editor-model";

export type BudgetChoice = BudgetTarget & Readonly<{ value: string; label: string }>;
type Category = CanonicalSuccess<"categories.listCategories">["data"][number];
type BudgetStatus = CanonicalSuccess<"budgets.getBudgetStatus">["data"]["statuses"][number];
export const budgetChoices = ({
  statuses,
  categories,
}: Readonly<{
  statuses: ReadonlyArray<BudgetStatus>;
  categories: ReadonlyArray<Category>;
}>): ReadonlyArray<BudgetChoice> =>
  statuses
    .flatMap(({ budget }) => {
      const category = categories.find(({ id }) => id === budget.categoryId);
      return category === undefined
        ? []
        : [
            {
              value: budget.id,
              label: `${category.label} · ${budget.cap.currency}`,
              categoryId: budget.categoryId,
              currency: budget.cap.currency,
            },
          ];
    })
    .sort((first, second) => first.label.localeCompare(second.label, "es-CO"));
