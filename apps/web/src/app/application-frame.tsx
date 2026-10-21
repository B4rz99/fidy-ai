import { Outlet, useRouterState } from "@tanstack/react-router";
import { type JSX, Suspense, lazy } from "react";
import { AccessRefused, ApplicationShell } from "@/features/signed-in/feature";
import { useSession } from "@/session/session-context";
import { HostedAgentProvider } from "@/features/agent/feature";
import { RetainedRecurringWorkspace } from "./recurring-workspace";
import { RetainedReviewWorkspace } from "./review-workspace";

const ReviewPendingCount = lazy(() =>
  import("@/features/needs-review/feature").then((module) => ({
    default: module.ReviewPendingCount,
  }))
);

/** One application shell survives navigation across independently authorized product routes. */
export const ApplicationFrame = (): JSX.Element => {
  const route = useRouterState({
    select: (state) => {
      if (state.matches.some((match) => match.routeId === "/authenticated")) {
        return "authenticated";
      }
      if (state.matches.some((match) => match.routeId === "/independent-application")) {
        return "independent";
      }
      return "standalone";
    },
  });
  const { authentication } = useSession();
  const privacy = useRouterState({
    select: (state) => state.location.pathname === "/settings/privacy",
  });
  if (route === "authenticated" && authentication === "expired") return <AccessRefused />;
  if (route === "standalone") return <Outlet />;
  const shell = (
    <ApplicationShell
      reviewPendingCount={
        <Suspense fallback={null}>
          <ReviewPendingCount />
        </Suspense>
      }
    >
      <RetainedReviewWorkspace />
      <RetainedRecurringWorkspace />
    </ApplicationShell>
  );
  return privacy || authentication === "expired" ? (
    shell
  ) : (
    <HostedAgentProvider>{shell}</HostedAgentProvider>
  );
};
