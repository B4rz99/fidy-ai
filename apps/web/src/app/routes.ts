import { Option } from "effect";
import {
  type RouterHistory,
  createRootRouteWithContext,
  createRouter,
} from "@tanstack/react-router";
import { createPublicSiteRoute } from "@/features/public-site/feature";
import type { FidyClient } from "@/transport/client";
import { ApplicationRoot } from "./root-route";

type WebRouterContext = Readonly<{ apiClient: FidyClient }>;
type WebRouterOptions = WebRouterContext & Readonly<{ history: Option.Option<RouterHistory> }>;

const rootRoute = createRootRouteWithContext<WebRouterContext>()({
  component: ApplicationRoot,
});
const routeTree = rootRoute.addChildren([createPublicSiteRoute(rootRoute)]);

/** Builds the application router from independently owned route subtrees. */
export const createWebRouter = (options: WebRouterOptions) =>
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
