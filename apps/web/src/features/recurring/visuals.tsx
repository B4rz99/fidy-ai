import type { JSX } from "react";
import { Calendar03Icon, CreditCardIcon } from "@hugeicons/core-free-icons";
import { IconIndicator } from "@/ui/components/icon-indicator";
import { CategoryVisual } from "@/ui/components/category-visual";
import { type Category, type PlanInput, frequencies } from "./model";

export const RecurringIdentity = ({ plan }: Readonly<{ plan: PlanInput }>): JSX.Element => (
  <span className="flex min-w-0 flex-1 items-center gap-3">
    <IconIndicator
      icon={plan.cardPayment === true ? CreditCardIcon : Calendar03Icon}
      tone={plan.kind === "income" ? "sage" : "peach"}
      appearance="category"
    />
    <span className="min-w-0 flex-1">
      <span title={plan.name} className="line-clamp-2 font-medium [overflow-wrap:anywhere]">
        {plan.name}
      </span>
      <span className="block truncate text-xs text-muted-foreground">
        {plan.cardPayment === true ? "Pago de tarjeta · " : ""}
        {frequencies.find(([frequency]) => frequency === plan.frequency)?.[1]}
      </span>
    </span>
  </span>
);
export const RecurringCategory = ({
  plan,
  categories,
}: Readonly<{ plan: PlanInput; categories: ReadonlyArray<Category> }>): JSX.Element => {
  const label =
    categories.find((category) => category.id === plan.categoryId)?.label ?? "Sin categoría";
  return (
    <span className="flex items-center gap-2 text-muted-foreground">
      <CategoryVisual label={label} bubble large={false} />
      <span>{label}</span>
    </span>
  );
};
