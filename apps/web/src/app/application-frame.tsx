import { useNavigationPreparation } from "./navigation-preparation";
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { type JSX, Suspense, lazy, useMemo, useState } from "react";
import { AccessRefused, ApplicationShell } from "@/features/signed-in/feature";
import { useSession } from "@/session/session-context";
import { HostedAgentProvider } from "@/features/agent/feature";
import { OAuthAgent } from "./oauth-agent";
import { RetainedRecurringWorkspace } from "./recurring-workspace";
import { RetainedReviewWorkspace } from "./review-workspace";
import { DestinationPreloadContext } from "./destination-preload-context";
import { destinationCodePreloads } from "./destination-components";

const ReviewPendingCount = lazy(() =>
  import("@/features/needs-review/feature").then((module) => ({
    default: module.ReviewPendingCount,
  }))
);

/** One application shell survives navigation across independently authorized product routes. */
export const ApplicationFrame = (): JSX.Element => {
  const prepareNavigation = useNavigationPreparation();
  const router = useRouter();
  const [attempted] = useState(() => new Set<string>());
  const destinations = useMemo(
    () => ({
      code: destinationCodePreloads,
      idle: router.options.context.browserRequestsIdle,
      display: destinationCodePreloads.flatMap((destination) => {
        if (!["/app/budgets", "/app/recurring", "/app/dashboard"].includes(destination.path)) {
          return [];
        }
        return [
          {
            path: destination.path,
            prepare: (): Promise<void> => {
              if (attempted.has(destination.path)) return Promise.resolve();
              attempted.add(destination.path);
              return destination.path === router.state.location.pathname
                ? Promise.resolve()
                : prepareNavigation(destination.path);
            },
          },
        ];
      }),
    }),
    [attempted, prepareNavigation, router]
  );
  return (
    <DestinationPreloadContext value={destinations}>
      <ApplicationContent />
    </DestinationPreloadContext>
  );
};

const ApplicationContent = (): JSX.Element => {
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
    select: (state) =>
      state.matches.some(
        (match) =>
          match.routeId === "/independent-application/settings/privacy" ||
          match.routeId === "/independent-application/connections/result" ||
          match.routeId === "/independent-application/upgrade" ||
          match.routeId === "/independent-application/oauth/review/$requestId"
      ),
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
    <HostedAgentProvider>{shell}</HostedAgentProvider>
  );
};
