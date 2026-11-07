import { useNavigationPreparation } from "./navigation-preparation";
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
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

const independentControlRoutes: ReadonlySet<string> = new Set([
  "/independent-application/settings/privacy",
  "/independent-application/connections/result",
  "/independent-application/upgrade",
  "/independent-application/oauth/review/$requestId",
]);

export const ApplicationFrame = (): JSX.Element => {
  const client = useRouter().options.context.hostedTurnClient;
  const { authentication } = useSession();
  const prepareNavigation = useNavigationPreparation();
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
        (match) => match.routeId === "/independent-application/oauth/review/$requestId"
      ),
  });
  const independentControls = useRouterState({
    select: (state) => state.matches.some((match) => independentControlRoutes.has(match.routeId)),
  });
  if (frame === "refused") return <AccessRefused />;
  if (frame === "standalone") return <Outlet />;
  const shell = (
    <ApplicationShell
      prepareNavigation={(destination) => {
        prepareNavigation(destination).catch(() => undefined);
      }}
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
    <HostedAgentProvider client={client}>{shell}</HostedAgentProvider>
  );
};
