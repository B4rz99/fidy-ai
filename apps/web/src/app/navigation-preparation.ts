import { useCallback } from "react";
import { type AnyRouter, useRouter, useRouterState } from "@tanstack/react-router";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { transactionEntryConsent } from "@/session/transaction-entry";
import { useSession } from "@/session/session-context";
import { BudgetsFeature } from "@/features/budgets/feature";
import { NeedsReviewFeature } from "@/features/needs-review/feature";
import { preloadDestinationCode } from "./destination-components";
import type { WebRouterContext } from "./router-context";

const prepareDisplay = (
  router: AnyRouter,
  context: WebRouterContext,
  { destination, signal }: Readonly<{ destination: string; signal: AbortSignal }>
): Promise<unknown> => {
  const { apiClient, registry } = context;
  switch (destination) {
    case "/app/needs-review":
      return NeedsReviewFeature.preloadMaterial({ client: apiClient, registry });
    case "/app/budgets":
      return BudgetsFeature.preloadData({
        apiClient,
        registry,
        month: Option.none(),
        signal: Option.some(signal),
      });
    case "/app/recurring":
      return import("@/features/recurring/feature").then(({ RecurringRoute }) =>
        signal.aborted
          ? undefined
          : RecurringRoute.preloadData({
              apiClient,
              registry,
              month: Option.none(),
              signal,
              intent: true,
            })
      );
    case "/app/transactions":
      return import("./transactions-page").then(({ TransactionsPage }) =>
        signal.aborted
          ? undefined
          : TransactionsPage.preloadData({ apiClient, registry, signal, search: {} })
      );
    case "/app/dashboard":
      return import("./dashboard-page").then(({ DashboardPage }) =>
        signal.aborted
          ? undefined
          : DashboardPage.preloadData({ apiClient, registry, router, signal })
      );
    default:
      return Promise.resolve();
  }
};

const canPrepareDisplay = (router: AnyRouter, context: WebRouterContext): boolean => {
  if (router.state.location.pathname !== "/app/transactions") return true;
  const { registry, webAuthClient } = context;
  const consent = registry.get(transactionEntryConsent(webAuthClient));
  return AsyncResult.isSuccess(consent) && !consent.waiting && consent.value.status === "Granted";
};

export const useNavigationPreparation = (): ((destination: string) => Promise<void>) => {
  const router = useRouter();
  const { authentication } = useSession();
  const privateSignal = useRouterState({
    select: (state) =>
      state.matches.find(
        (match) =>
          match.routeId === "/authenticated" ||
          match.routeId === "/independent-application/app/transactions"
      )?.abortController.signal,
  });
  return useCallback(
    (destination: string): Promise<void> => {
      if (
        authentication === "expired" ||
        privateSignal === undefined ||
        privateSignal.aborted ||
        !canPrepareDisplay(router, router.options.context)
      ) {
        return Promise.resolve();
      }
      return Promise.allSettled([
        preloadDestinationCode(destination),
        prepareDisplay(router, router.options.context, { destination, signal: privateSignal }),
      ]).then(() => undefined);
    },
    [authentication, privateSignal, router]
  );
};
