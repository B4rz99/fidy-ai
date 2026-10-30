import { useCallback } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { Option } from "effect";
import { useSession } from "@/session/session-context";
import { BudgetsFeature } from "@/features/budgets/feature";
import { NeedsReviewFeature } from "@/features/needs-review/feature";

export const useNavigationPreparation = (): ((destination: string) => void) => {
  const router = useRouter();
  const { authentication } = useSession();
  const privateSignal = useRouterState({
    select: (state) =>
      state.matches.find((match) => match.routeId === "/authenticated")?.abortController.signal,
  });
  return useCallback(
    (destination: string): void => {
      if (authentication === "expired" || privateSignal === undefined || privateSignal.aborted) {
        return;
      }
      const { apiClient, registry } = router.options.context;
      if (destination === "/app/needs-review") {
        NeedsReviewFeature.preloadMaterial({
          client: apiClient,
          registry,
        }).catch(() => undefined);
      }
      if (destination === "/app/budgets") {
        BudgetsFeature.preloadData({
          apiClient,
          registry,
          month: Option.none(),
          signal: Option.some(privateSignal),
        }).catch(() => undefined);
      }
      if (destination === "/app/recurring") {
        import("@/features/recurring/feature")
          .then(({ RecurringRoute }) =>
            RecurringRoute.preloadData({
              apiClient,
              registry,
              month: Option.none(),
              signal: privateSignal,
              intent: true,
            })
          )
          .catch(() => undefined);
      }
    },
    [authentication, privateSignal, router]
  );
};
