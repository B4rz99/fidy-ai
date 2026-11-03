import { lazyRouteComponent } from "@tanstack/react-router";
import { type JSX, type ReactNode } from "react";
import { preloadBudgetData } from "./queries";

const Screen = lazyRouteComponent(() => import("./screen"), "BudgetScreen");
export const BudgetsFeature = ({ children }: Readonly<{ children: ReactNode }>): JSX.Element => (
  <Screen>{children}</Screen>
);
BudgetsFeature.preload = (): Promise<void> => Screen.preload?.() ?? Promise.resolve();
BudgetsFeature.preloadData = preloadBudgetData;
