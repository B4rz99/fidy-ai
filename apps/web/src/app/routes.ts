import { Option, Schema } from "effect";
import { OAuthConnectionListQuery, OAuthRequestId } from "@/transport/client";
import { OAuthManagementFeature, OAuthReviewFeature } from "@/features/oauth-connections/feature";
import { type JSX, Suspense, createElement, lazy } from "react";
import {
  type RouterHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { BrowserLoginPairingFeature } from "@/features/browser-login/feature";
import { HostedAgentFeature } from "@/features/agent/feature";
import { EmailOnboardingFeature } from "@/features/email-onboarding/feature";
import { EmailReplacementFeature } from "@/features/email-replacement/feature";
import { createPublicSiteRoute } from "@/features/public-site/feature";
import { PATManagementFeature } from "@/features/pats/feature";
import { BackupRecoveryFeature } from "@/features/recovery/feature";
import { SignedInFeature } from "@/features/signed-in/feature";
import { SubscriptionOffersFeature } from "@/features/subscription/feature";
import { TransactionListFeature } from "@/features/transactions/feature";
import type { FidyClient, HostedTurnClient, WebAuthClient } from "@/transport/client";

type WebRouterContext = Readonly<{
  apiClient: FidyClient;
  webAuthClient: WebAuthClient;
  hostedTurnClient: HostedTurnClient;
}>;
type WebRouterOptions = WebRouterContext &
  Readonly<{
    history: Option.Option<RouterHistory>;
  }>;

const DashboardRouteContent = lazy(() =>
  import("@/features/dashboard/feature").then((module) => ({
    default: module.DashboardFeature,
  }))
);
const DashboardRoute = (): JSX.Element => {
  const router = useRouter();
  return createElement(
    Suspense,
    { fallback: createElement("p", { "aria-live": "polite" }, "Cargando tablero…") },
    createElement(DashboardRouteContent, {
      apiClient: router.options.context.apiClient,
    })
  );
};

const rootRoute = createRootRouteWithContext<WebRouterContext>()({});
const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authenticated",
  component: SignedInFeature,
});
const signedInRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/app",
});
const signedInIndexRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/",
  beforeLoad: () => redirect({ to: "/app/dashboard" }),
});
const dashboardRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/dashboard",
  component: DashboardRoute,
});
const agentRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/agent",
  component: HostedAgentFeature,
});
const transactionsRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/transactions",
  component: TransactionListFeature,
});
const patManagementRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/pats",
  component: PATManagementFeature,
});
const oauthManagementRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/agents",
  validateSearch: (search) =>
    Schema.decodeSync(Schema.Struct({ after: OAuthConnectionListQuery.fields.after.from }))(search),
  component: OAuthManagementFeature,
});
const emailReplacementRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/email",
  component: EmailReplacementFeature,
});
const backupRecoveryRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/recovery",
  component: BackupRecoveryFeature,
});
const subscriptionOffersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/upgrade",
  component: SubscriptionOffersFeature,
});
const browserLoginPairingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/pair",
  validateSearch: (search) =>
    Schema.decodeSync(Schema.Struct({ oauthRequest: Schema.optionalKey(OAuthRequestId) }))(search),
  component: BrowserLoginPairingFeature,
});
const oauthReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/oauth/review/$requestId",
  component: OAuthReviewFeature,
});
const emailOnboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/verify-email",
  component: EmailOnboardingFeature,
});
const routeTree = rootRoute.addChildren([
  createPublicSiteRoute(rootRoute),
  browserLoginPairingRoute,
  oauthReviewRoute,
  subscriptionOffersRoute,
  emailOnboardingRoute,
  authenticatedRoute.addChildren([
    signedInRoute.addChildren([signedInIndexRoute, dashboardRoute, agentRoute, transactionsRoute]),
    patManagementRoute,
    oauthManagementRoute,
    emailReplacementRoute,
    backupRecoveryRoute,
  ]),
]);

/** Builds the application router from independently owned route subtrees. */
export const createWebRouter = (options: WebRouterOptions) =>
  createRouter({
    routeTree,
    context: {
      apiClient: options.apiClient,
      webAuthClient: options.webAuthClient,
      hostedTurnClient: options.hostedTurnClient,
    },
    history: Option.getOrUndefined(options.history),
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createWebRouter>;
  }
}
