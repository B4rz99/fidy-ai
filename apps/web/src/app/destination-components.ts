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
          yield* Effect.tryPromise(() => Promise.resolve(RecurringRoute.preload?.()));
          yield* Effect.tryPromise(() =>
            Promise.all([RecurringWorkspace.preload?.(), TransactionCaptureFeature.preload()])
          );
        })
      ),
  },
  { path: "/app/dashboard", load: (): Promise<unknown> => import("./dashboard-page") },
  { path: "/app/transactions", load: (): Promise<unknown> => import("./transactions-page") },
  { path: "/settings/account", load: (): Promise<unknown> => import("./account-page") },
  { path: "/settings/access", load: (): Promise<unknown> => import("./access-page") },
  { path: "/settings/privacy", load: (): Promise<unknown> => import("@/features/privacy/feature") },
  { path: "/upgrade", load: (): Promise<unknown> => import("@/features/subscription/feature") },
] as const;

export const preloadDestinationCode = (path: string): Promise<unknown> =>
  destinationCodePreloads.find((destination) => destination.path === path)?.load() ??
  Promise.resolve();
