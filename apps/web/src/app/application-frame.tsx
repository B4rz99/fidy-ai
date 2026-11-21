import { useNavigationPreparation } from "./navigation-preparation";
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ProcessingConsentStatus } from "@/transport/client";
import { transactionEntryConsent } from "@/session/transaction-entry";
import { type JSX, Suspense, lazy, useState } from "react";
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
        (match) => match.routeId === "/independent-application/oauth/review/$requestId"
      ),
  });

  const independentControls = useRouterState({
    select: (state) => state.matches.some((match) => independentControlRoutes.has(match.routeId)),
  });

  if (frame === "standalone") return <Outlet />;

  return (
    <ConsentApplicationFrame
      frame={frame}
      oauthReview={oauthReview}
      independentControls={independentControls}
    />
  );
};

const hasWithdrawnConsent = (
  state: AsyncResult.AsyncResult<ProcessingConsentStatus, unknown>
): boolean => AsyncResult.isSuccess(state) && !state.waiting && state.value.status === "Revoked";

const ConsentApplicationFrame = ({
  frame,
  oauthReview,
  independentControls,
}: Readonly<{
  frame: "refused" | "application";
  oauthReview: boolean;
  independentControls: boolean;
}>): JSX.Element => {
  const { webAuthClient } = useRouter().options.context;
  const [query] = useState(() => transactionEntryConsent(webAuthClient));
  const readOnly = useAtomValue(query, hasWithdrawnConsent);

  const authenticatedRoute = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId === "/authenticated"),
  });

  if (readOnly) {
    return (
      <ApplicationShell readOnly prepareNavigation={() => undefined} reviewPendingCount={null}>
        {authenticatedRoute ? <AccessRefused withdrawn /> : <Outlet />}
      </ApplicationShell>
    );
  }

  if (frame === "refused") return <AccessRefused withdrawn={false} />;

  return (
    <ProductApplicationFrame oauthReview={oauthReview} independentControls={independentControls} />
  );
};

const ProductApplicationFrame = ({
  oauthReview,
  independentControls,
}: Readonly<{
  oauthReview: boolean;
  independentControls: boolean;
}>): JSX.Element => {
  const { hostedTurnClient: client } = useRouter().options.context;
  const { authentication } = useSession();
  const prepareNavigation = useNavigationPreparation();

  const shell = (
    <ApplicationShell
      readOnly={false}
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
      <Outlet />
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
