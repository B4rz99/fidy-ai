import { RecurringDigestFeature } from "@/features/recurring-digest/feature";
import { Option, Schema } from "effect";
import {
  ConnectionAttemptReference,
  OAuthConnectionListQuery,
  OAuthRequestId,
  ProviderHandoffSearch,
} from "@/transport/client";
import { ConnectionContinuationFeature } from "@/features/connections/feature";
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
import {
  ProviderAuthenticationFeature,
  ProviderReturnFeature,
} from "@/features/provider-authentication/feature";
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
const recurringDigestRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/insights/recurring/$id",
  component: RecurringDigestFeature,
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
    Schema.decodeSync(
      Schema.Struct({
        oauthRequest: Schema.optionalKey(OAuthRequestId),
        connectionAttempt: Schema.optionalKey(ConnectionAttemptReference),
      })
    )(search),
  component: BrowserLoginPairingFeature,
});
const oauthReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/oauth/review/$requestId",
  component: OAuthReviewFeature,
});
const connectionContinuationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connections/continue",
  validateSearch: (search) =>
    Schema.decodeSync(Schema.Struct({ attempt: Schema.optionalKey(Schema.Unknown) }))(search),
  component: ConnectionContinuationFeature,
});

const GoogleAuthentication = (): JSX.Element =>
  createElement(ProviderAuthenticationFeature, {
    provider: "google",
    handoffReference: Option.fromUndefinedOr(googleRoute.useSearch().handoff),
  });
const MicrosoftAuthentication = (): JSX.Element =>
  createElement(ProviderAuthenticationFeature, {
    provider: "microsoft",
    handoffReference: Option.fromUndefinedOr(microsoftRoute.useSearch().handoff),
  });

const googleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/google",
  validateSearch: (search) => Schema.decodeSync(ProviderHandoffSearch)(search),
  component: GoogleAuthentication,
});
const googleReturnRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/google-return",
  component: () => createElement(ProviderReturnFeature, { provider: "google" }),
});
const microsoftRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/microsoft",
  validateSearch: (search) => Schema.decodeSync(ProviderHandoffSearch)(search),
  component: MicrosoftAuthentication,
});
const microsoftReturnRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/microsoft-return",
  component: () => createElement(ProviderReturnFeature, { provider: "microsoft" }),
});
const routeTree = rootRoute.addChildren([
  createPublicSiteRoute(rootRoute),
  browserLoginPairingRoute,
  googleRoute,
  googleReturnRoute,
  microsoftRoute,
  microsoftReturnRoute,
  oauthReviewRoute,
  connectionContinuationRoute,
  subscriptionOffersRoute,
  authenticatedRoute.addChildren([
    signedInRoute.addChildren([signedInIndexRoute, dashboardRoute, agentRoute, transactionsRoute]),
    patManagementRoute,
    oauthManagementRoute,
    recurringDigestRoute,
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
