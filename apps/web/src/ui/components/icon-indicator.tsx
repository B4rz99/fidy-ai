import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDownLeft01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { ComponentProps, JSX } from "react";
import { cn } from "@/ui/class-names";

type IndicatorTone =
  | "sage"
  | "sky"
  | "peach"
  | "lavender"
  | "butter"
  | "rose"
  | "income"
  | "expense";
const iconSizes = { plain: 20, category: 20, "category-large": 30, direction: 18 } as const;

/** Decorative pastel indicator; callers supply an adjacent accessible label and retain category identity. */
export const IconIndicator = ({
  icon,
  tone,
  appearance,
}: Readonly<{
  icon: ComponentProps<typeof HugeiconsIcon>["icon"];
  tone: IndicatorTone;
  appearance: keyof typeof iconSizes;
}>): JSX.Element => (
  <span
    aria-hidden="true"
    data-tone={tone}
    className={cn(
      "category-visual",
      appearance !== "direction" && "shrink-0",
      (appearance === "category" || appearance === "category-large") && "category-bubble",
      appearance === "category-large" && "category-bubble-large",
      appearance === "direction" && "direction-bubble"
    )}
  >
    <HugeiconsIcon icon={icon} size={iconSizes[appearance]} strokeWidth={1.5} />
  </span>
);

/** Income and spending retain explicit direction icons; normal spending is not an error state. */
export const DirectionIndicator = ({ inflow }: Readonly<{ inflow: boolean }>): JSX.Element => (
  <IconIndicator
    icon={inflow ? ArrowDownLeft01Icon : ArrowUpRight01Icon}
    tone={inflow ? "income" : "expense"}
    appearance="direction"
  />
);
