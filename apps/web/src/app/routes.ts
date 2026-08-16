import { Option } from "effect";
import {
  type RouterHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { NotFoundFeature } from "@/features/not-found/feature";
import { HomeFeature } from "@/features/home/feature";
import { PrivacyPolicyFeature } from "@/features/privacy-policy/feature";
import { PublicShellFeature } from "@/features/public-shell/feature";
import type { FidyClient } from "@/transport/client";

type WebRouterContext = Readonly<{ apiClient: FidyClient }>;
type WebRouterOptions = WebRouterContext & Readonly<{ history: Option.Option<RouterHistory> }>;

const rootRoute = createRootRouteWithContext<WebRouterContext>()({
  component: PublicShellFeature,
  notFoundComponent: NotFoundFeature,
});
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeFeature,
});
const policyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/politica",
  component: PrivacyPolicyFeature,
});
const routeTree = rootRoute.addChildren([homeRoute, policyRoute]);

/** Builds the public router for browser startup and isolated memory-history tests. */
export const createWebRouter = (options: WebRouterOptions): ReturnType<typeof createRouter> =>
  createRouter({
    routeTree,
    context: { apiClient: options.apiClient },
    history: Option.getOrUndefined(options.history),
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createWebRouter>;
  }
}
