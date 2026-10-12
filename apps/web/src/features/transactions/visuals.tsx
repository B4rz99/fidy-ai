import type { HugeiconsIcon } from "@hugeicons/react";
import {
  Briefcase01Icon,
  Bus01Icon,
  ComputerIcon,
  CreditCardIcon,
  Home01Icon,
  Restaurant01Icon,
  ShoppingCart01Icon,
} from "@hugeicons/core-free-icons";
import type { ComponentProps, JSX } from "react";
import { IconIndicator } from "@/ui/components/icon-indicator";

type CategoryIllustration = Readonly<{
  icon: ComponentProps<typeof HugeiconsIcon>["icon"];
  tone: "sage" | "sky" | "peach" | "lavender" | "butter" | "rose";
}>;
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
  const compactAppearance = bubble ? "category" : "plain";
  return (
    <IconIndicator
      icon={visual.icon}
      tone={visual.tone}
      appearance={large ? "category-large" : compactAppearance}
    />
  );
};
