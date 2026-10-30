import { Effect } from "effect";
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
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => Promise.resolve(BudgetRoute.preload?.()));
        const { BudgetsFeature } = yield* Effect.tryPromise(
          () => import("@/features/budgets/feature")
        );
        yield* Effect.tryPromise(() => BudgetsFeature.preload());
      })
    ),
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => Promise.resolve(RecurringRoute.preload?.()));
        yield* Effect.tryPromise(() => Promise.resolve(RecurringWorkspace.preload?.()));
      })
    ),
];
