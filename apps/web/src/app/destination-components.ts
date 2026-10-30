import { lazyRouteComponent } from "@tanstack/react-router";
import { RecurringWorkspace, ReviewWorkspace } from "./workspace-components";

export const BudgetRoute = lazyRouteComponent(
  () => import("@/features/budgets/feature"),
  "BudgetsFeature"
);
export const RecurringRoute = lazyRouteComponent(
  () => import("@/features/recurring/feature"),
  "RecurringRoute"
);
/** Code only; the browser adapter yields between destinations and can retire the queue. */
export const destinationCodePreloads: ReadonlyArray<() => Promise<unknown>> = [
  () => ReviewWorkspace.preload(),
  async () => {
    await BudgetRoute.preload?.();
    const { BudgetsFeature } = await import("@/features/budgets/feature");
    await BudgetsFeature.preload();
  },
  async () => {
    await RecurringRoute.preload?.();
    await RecurringWorkspace.preload?.();
  },
];
