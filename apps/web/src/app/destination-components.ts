import { preloadBudgetScreen } from "@/features/budgets/code";
import { preloadTransactionList } from "@/features/transactions/code";
import { preloadDashboardView } from "@/features/dashboard/code";
import { preloadRecurringScreen } from "@/features/recurring/code";
import { preloadSubscriptionScreen } from "@/features/subscription/code";
import { TransactionCaptureFeature } from "@/features/transactions/feature";
import { Effect } from "effect";
import { lazyRouteComponent } from "@tanstack/react-router";
import { RecurringWorkspace, ReviewWorkspace } from "./workspace-components";

export const BudgetRoute = lazyRouteComponent(() => import("./budget-page"), "BudgetPage");
export const RecurringRoute = lazyRouteComponent(
  () => import("@/features/recurring/feature"),
  "RecurringRoute"
);
/** Code only; the browser adapter yields between destinations and can retire the queue. */
export const destinationCodePreloads = [
  { path: "/app/needs-review", load: (): Promise<unknown> => ReviewWorkspace.preload() },
  {
    path: "/app/budgets",
    load: (): Promise<unknown> =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.tryPromise(preloadBudgetScreen);
          yield* Effect.tryPromise(() => Promise.resolve(BudgetRoute.preload?.()));
          const { BudgetsFeature } = yield* Effect.tryPromise(
            () => import("@/features/budgets/feature")
          );
          yield* Effect.tryPromise(() => BudgetsFeature.preload());
        })
      ),
  },
  {
    path: "/app/recurring",
    load: (): Promise<unknown> =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.tryPromise(preloadRecurringScreen);
          yield* Effect.tryPromise(() => Promise.resolve(RecurringRoute.preload?.()));
          yield* Effect.tryPromise(() =>
            Promise.all([RecurringWorkspace.preload?.(), TransactionCaptureFeature.preload()])
          );
        })
      ),
  },
  {
    path: "/app/dashboard",
    load: (): Promise<unknown> => Promise.all([import("./dashboard-page"), preloadDashboardView()]),
  },
  {
    path: "/app/transactions",
    load: (): Promise<unknown> =>
      Promise.all([import("./transactions-page"), preloadTransactionList()]),
  },
  { path: "/settings/account", load: (): Promise<unknown> => import("./account-page") },
  { path: "/settings/access", load: (): Promise<unknown> => import("./access-page") },
  { path: "/settings/privacy", load: (): Promise<unknown> => import("@/features/privacy/feature") },
  { path: "/upgrade", load: preloadSubscriptionScreen },
] as const;

export const preloadDestinationCode = (path: string): Promise<unknown> =>
  destinationCodePreloads.find((destination) => destination.path === path)?.load() ??
  Promise.resolve();
