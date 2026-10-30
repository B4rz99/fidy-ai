import { preloadReviewMaterial, prepareReviewWorkspace } from "./query";
import { lazyRouteComponent } from "@tanstack/react-router";
import { type ComponentProps, type JSX, memo } from "react";

export { ReviewPendingCount } from "./navigation";

/** Public composition stays small; the route and retained owner preload the same workspace. */
const Workspace = lazyRouteComponent(() =>
  import("./workspace").then((module) => ({ default: memo(module.NeedsReviewFeature) }))
);
const Route = lazyRouteComponent(() => import("./workspace"), "NeedsReviewRoute");

export const NeedsReviewFeature = (props: ComponentProps<typeof Workspace>): JSX.Element => (
  <Workspace {...props} />
);
NeedsReviewFeature.preload = async (): Promise<void> => {
  await Promise.all([Workspace.preload?.(), Route.preload?.()]);
};

NeedsReviewFeature.preloadData = prepareReviewWorkspace;
NeedsReviewFeature.preloadMaterial = preloadReviewMaterial;

export const NeedsReviewRoute = (): JSX.Element => <Route />;
