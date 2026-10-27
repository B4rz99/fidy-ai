import { Outlet, useRouterState } from "@tanstack/react-router";
import { type JSX, Suspense, lazy } from "react";
import { AccessRefused, ApplicationShell } from "@/features/signed-in/feature";
import { useSession } from "@/session/session-context";
import { HostedAgentProvider } from "@/features/agent/feature";
import { OAuthAgent } from "./oauth-agent";
import { RetainedRecurringWorkspace } from "./recurring-workspace";
import { RetainedReviewWorkspace } from "./review-workspace";

const ReviewPendingCount = lazy(() =>
  import("@/features/needs-review/feature").then((module) => ({
    default: module.ReviewPendingCount,
  }))
);

/** One application shell survives navigation across independently authorized product routes. */
export const ApplicationFrame = (): JSX.Element => {
  const { authentication } = useSession();
  const frame = useRouterState({
    select: (state) => {
      if (state.matches.some((match) => match.routeId === "/authenticated")) {
        return authentication === "expired" ? "refused" : "application";
      }
      if (state.matches.some((match) => match.routeId === "/independent-application")) {
        return "application";
      }
      return "standalone";
    },
  });
  const oauthReview = useRouterState({
    select: (state) =>
      state.matches.some(
        (match) =>
          match.routeId === "/independent-application/oauth/review/$requestId" ||
          match.routeId === "/independent-application/oauth/operation/$reference"
      ),
  });
  const independentControls = useRouterState({
    select: (state) =>
      state.matches.some(
        (match) =>
          match.routeId === "/independent-application/settings/privacy" ||
          match.routeId === "/independent-application/connections/result" ||
          match.routeId === "/independent-application/upgrade" ||
          match.routeId === "/independent-application/oauth/review/$requestId" ||
          match.routeId === "/independent-application/oauth/operation/$reference"
      ),
  });
  if (frame === "refused") return <AccessRefused />;
  if (frame === "standalone") return <Outlet />;
  const shell = (
    <ApplicationShell
      reviewPendingCount={
        independentControls ? null : (
          <Suspense fallback={null}>
            <ReviewPendingCount />
          </Suspense>
        )
      }
    >
      {oauthReview ? <OAuthAgent /> : null}
      {independentControls ? null : (
        <>
          <RetainedReviewWorkspace />
          <RetainedRecurringWorkspace />
        </>
      )}
    </ApplicationShell>
  );
  return independentControls || authentication === "expired" ? (
    shell
  ) : (
    <HostedAgentProvider>{shell}</HostedAgentProvider>
  );
};
