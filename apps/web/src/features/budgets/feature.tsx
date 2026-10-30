import { lazyRouteComponent } from "@tanstack/react-router";
import { type JSX } from "react";
import { preloadBudgetData } from "./queries";

const Screen = lazyRouteComponent(() => import("./screen"), "BudgetScreen");
export const BudgetsFeature = (): JSX.Element => <Screen />;
BudgetsFeature.preload = (): Promise<void> => Screen.preload?.() ?? Promise.resolve();
BudgetsFeature.preloadData = preloadBudgetData;
