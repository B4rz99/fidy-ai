import type { JSX } from "react";
import { InlineChoiceDropdown } from "@/ui/components/choice-dropdown";
import { CategoryVisual } from "@/ui/components/category-visual";
import type { Category, Occurrence, Save } from "./model";

/** Occurrence edits leave other dates and historical fulfillments intact. */
export const InlineRecurringCategory = ({
  item,
  categories,
  save,
  disabled,
}: Readonly<{
  item: Occurrence;
  categories: ReadonlyArray<Category>;
  save: Save;
  disabled: boolean;
}>): JSX.Element => {
  const label =
    categories.find((category) => category.id === item.plan.categoryId)?.label ?? "Sin categoría";
  return (
    <InlineChoiceDropdown
      label={`Cambiar categoría de ${item.plan.name}`}
      disabled={disabled || item.fulfillments.length > 0}
      leading={<CategoryVisual label={label} bubble large={false} />}
      value={item.plan.categoryId ?? ""}
      options={categories.map((category) => ({ value: category.id, label: category.label }))}
      onChange={(value) => {
        if (disabled || item.fulfillments.length > 0 || value === item.plan.categoryId) return;
        const category = categories.find((entry) => entry.id === value);
        if (category === undefined) return;
        save({
          kind: "edit",
          planId: item.planId,
          date: item.date,
          scope: "once",
          plan: { ...item.plan, categoryId: category.id, firstDate: item.expectedDate },
        });
      }}
    >
      {label}
    </InlineChoiceDropdown>
  );
};
