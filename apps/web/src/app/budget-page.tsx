import type { JSX } from "react";
import { BudgetsFeature } from "@/features/budgets/feature";
import { DestinationCodePreload } from "./destination-code-preload";

export const BudgetPage = (): JSX.Element => (
  <BudgetsFeature>
    <DestinationCodePreload />
  </BudgetsFeature>
);
