import { useCallback } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { Option } from "effect";
import { useSession } from "@/session/session-context";
import { BudgetsFeature } from "@/features/budgets/feature";
import { NeedsReviewFeature } from "@/features/needs-review/feature";

export const useNavigationPreparation = (): ((destination: string) => void) => {
  const router = useRouter();
  const { authentication } = useSession();
  const privateWorkspace = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId === "/authenticated"),
  });
  return useCallback(
    (destination: string): void => {
      if (authentication === "expired" || !privateWorkspace) return;
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
          signal: Option.none(),
        }).catch(() => undefined);
      }
    },
    [authentication, privateWorkspace, router]
  );
};
