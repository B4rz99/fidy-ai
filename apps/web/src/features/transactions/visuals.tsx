import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDownLeft01Icon,
  ArrowUpRight01Icon,
  Briefcase01Icon,
  Bus01Icon,
  ComputerIcon,
  CreditCardIcon,
  Home01Icon,
  Restaurant01Icon,
  ShoppingCart01Icon,
} from "@hugeicons/core-free-icons";
import type { ComponentProps, JSX } from "react";
import { cn } from "@/ui/class-names";

type CategoryIllustration = Readonly<{
  icon: ComponentProps<typeof HugeiconsIcon>["icon"];
  tone: "sage" | "sky" | "peach" | "lavender" | "butter" | "rose";
}>;
const LARGE_ICON_SIZE = 30;
const SMALL_ICON_SIZE = 20;
const categoryVisual = (label: string): CategoryIllustration => {
  const normalized = label.toLocaleLowerCase("es-CO");
  if (/restaur|comida/.test(normalized)) return { icon: Restaurant01Icon, tone: "rose" };
  if (/mercado|aliment|compra/.test(normalized)) {
    return { icon: ShoppingCart01Icon, tone: "sage" };
  }
  if (/entreten|suscrip/.test(normalized)) return { icon: ComputerIcon, tone: "sky" };
  if (/transport/.test(normalized)) return { icon: Bus01Icon, tone: "lavender" };
  if (/hogar|vivienda/.test(normalized)) return { icon: Home01Icon, tone: "butter" };
  if (/ingreso|salario/.test(normalized)) return { icon: Briefcase01Icon, tone: "sage" };
  return { icon: CreditCardIcon, tone: "peach" };
};
/** Category illustrations convey presentation only; canonical category identity stays unchanged. */
export const CategoryVisual = ({
  label,
  bubble,
  large,
}: Readonly<{ label: string; bubble: boolean; large: boolean }>): JSX.Element => {
  const visual = categoryVisual(label);
  return (
    <span
      aria-hidden="true"
      data-tone={visual.tone}
      className={cn(
        "category-visual shrink-0",
        bubble && "category-bubble",
        large && "category-bubble-large"
      )}
    >
      <HugeiconsIcon
        icon={visual.icon}
        size={large ? LARGE_ICON_SIZE : SMALL_ICON_SIZE}
        strokeWidth={1.5}
      />
    </span>
  );
};
export const DirectionVisual = ({ inflow }: Readonly<{ inflow: boolean }>): JSX.Element => (
  <span
    aria-hidden="true"
    data-tone={inflow ? "income" : "expense"}
    className="category-visual direction-bubble"
  >
    <HugeiconsIcon
      icon={inflow ? ArrowDownLeft01Icon : ArrowUpRight01Icon}
      size={18}
      strokeWidth={1.5}
    />
  </span>
);
