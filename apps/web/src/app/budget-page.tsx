import type { JSX } from "react";
import { BudgetsFeature } from "@/features/budgets/feature";
import { DestinationPreload } from "./destination-preload";

export const BudgetPage = (): JSX.Element => (
  <BudgetsFeature>
    <DestinationPreload />
  </BudgetsFeature>
);
