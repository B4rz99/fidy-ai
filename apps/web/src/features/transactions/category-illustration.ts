import {
  Briefcase01Icon,
  Bus01Icon,
  ComputerIcon,
  CreditCardIcon,
  Home01Icon,
  Restaurant01Icon,
  ShoppingCart01Icon,
} from "@hugeicons/core-free-icons";
import type { Html, HtmlBuilder } from "foldkit/html";
import { type IconData, icon } from "@/ui/icon";

const sizes = { large: 30, compact: 20 } as const;
type Illustration = Readonly<{
  data: IconData;
  tone: "sage" | "sky" | "peach" | "lavender" | "butter" | "rose";
}>;
const illustration = (label: string): Illustration => {
  const normalized = label.toLocaleLowerCase("es-CO");
  if (/restaur|comida/u.test(normalized)) return { data: Restaurant01Icon, tone: "rose" };
  if (/mercado|aliment|compra/u.test(normalized)) return { data: ShoppingCart01Icon, tone: "sage" };
  if (/entreten|suscrip/u.test(normalized)) return { data: ComputerIcon, tone: "sky" };
  if (/transport/u.test(normalized)) return { data: Bus01Icon, tone: "lavender" };
  if (/hogar|vivienda/u.test(normalized)) return { data: Home01Icon, tone: "butter" };
  if (/ingreso|salario/u.test(normalized)) return { data: Briefcase01Icon, tone: "sage" };
  return { data: CreditCardIcon, tone: "peach" };
};
export const categoryIllustration = <Message>({
  html,
  label,
  large,
}: Readonly<{ html: HtmlBuilder<Message>; label: string; large: boolean }>): Html => {
  const visual = illustration(label);
  return html.span(
    [
      html.AriaHidden(true),
      html.DataAttribute("tone", visual.tone),
      html.Class(
        `category-visual shrink-0 category-bubble${large ? " category-bubble-large" : ""}`
      ),
    ],
    [icon({ html, data: visual.data, size: large ? sizes.large : sizes.compact, className: "" })]
  );
};
