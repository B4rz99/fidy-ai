import { Option } from "effect";
import {
  type RouterHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { BrowserLoginPairingFeature } from "@/features/browser-login/feature";
import { createPublicSiteRoute } from "@/features/public-site/feature";
import { ManualPATFeature } from "@/features/pats/feature";
import { SignedInFeature } from "@/features/signed-in/feature";
import { SubscriptionOffersFeature } from "@/features/subscription/feature";
import { TransactionListFeature } from "@/features/transactions/feature";
import type { FidyClient, WebAuthClient } from "@/transport/client";

type WebRouterContext = Readonly<{
  apiClient: FidyClient;
  webAuthClient: WebAuthClient;
}>;
type WebRouterOptions = WebRouterContext &
  Readonly<{
    history: Option.Option<RouterHistory>;
  }>;

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
  beforeLoad: () => redirect({ to: "/app/transactions" }),
});
const transactionsRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/transactions",
  component: TransactionListFeature,
});
const manualPATRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/pats",
  component: ManualPATFeature,
});
const subscriptionOffersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/upgrade",
  component: SubscriptionOffersFeature,
});
const browserLoginPairingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/pair",
  component: BrowserLoginPairingFeature,
});
const routeTree = rootRoute.addChildren([
  createPublicSiteRoute(rootRoute),
  browserLoginPairingRoute,
  subscriptionOffersRoute,
  authenticatedRoute.addChildren([
    signedInRoute.addChildren([signedInIndexRoute, transactionsRoute]),
    manualPATRoute,
  ]),
]);

/** Builds the application router from independently owned route subtrees. */
export const createWebRouter = (options: WebRouterOptions) =>
  createRouter({
    routeTree,
    context: {
      apiClient: options.apiClient,
      webAuthClient: options.webAuthClient,
    },
    history: Option.getOrUndefined(options.history),
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createWebRouter>;
  }
}
