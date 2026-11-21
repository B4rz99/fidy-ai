import { browserRuntime } from "@/transport/browser-runtime";
import { preloadBudgetScreen } from "@/features/budgets/code";
import { preloadTransactionList } from "@/features/transactions/code";
import { preloadDashboardView } from "@/features/dashboard/code";
import { preloadRecurringScreen } from "@/features/recurring/code";
import { preloadSubscriptionScreen } from "@/features/subscription/code";
import { TransactionCaptureFeature } from "@/features/transactions/feature";
import { Effect } from "effect";
import { lazyRouteComponent } from "@tanstack/react-router";
import { RecurringWorkspace, ReviewWorkspace } from "./workspace-components";

const loaded = <A>(promise: Promise<A>): Promise<void> => promise.then(() => undefined);

export const BudgetRoute = lazyRouteComponent(() => import("./budget-page"), "BudgetPage");

export const RecurringRoute = lazyRouteComponent(
  () => import("@/features/recurring/feature"),
  "RecurringRoute"
);

export const destinationCodePreloads = [
  { path: "/app/needs-review", load: (): Promise<void> => loaded(ReviewWorkspace.preload()) },
  {
    path: "/app/budgets",
    load: (): Promise<void> =>
      browserRuntime.runPromise(
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
    load: (): Promise<void> =>
      browserRuntime.runPromise(
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
    load: (): Promise<void> =>
      loaded(Promise.all([import("./dashboard-page"), preloadDashboardView()])),
  },
  {
    path: "/app/transactions",
    load: (): Promise<void> =>
      loaded(Promise.all([import("./transactions-page"), preloadTransactionList()])),
  },
  { path: "/settings/account", load: (): Promise<void> => loaded(import("./account-page")) },
  { path: "/settings/access", load: (): Promise<void> => loaded(import("./access-page")) },
  {
    path: "/settings/privacy",
    load: (): Promise<void> => loaded(import("@/features/privacy/feature")),
  },
  { path: "/upgrade", load: preloadSubscriptionScreen },
] as const;

export const preloadDestinationCode = (path: string): Promise<void> =>
  destinationCodePreloads.find((destination) => destination.path === path)?.load() ??
  Promise.resolve();
