import { lazyRouteComponent } from "@tanstack/react-router";
import type { ComponentProps, JSX } from "react";

const Workspace = lazyRouteComponent(() => import("./workspace"), "NeedsReviewFeature");
const Route = lazyRouteComponent(() => import("./workspace"), "NeedsReviewRoute");

/** Public navigation remains independent of the retained editor and its presentation. */
export { ReviewPendingCount } from "./navigation";
export const NeedsReviewFeature = (
  props: Readonly<ComponentProps<typeof Workspace>>
): JSX.Element => <Workspace {...props} />;
NeedsReviewFeature.preload = (): Promise<[void, void]> =>
  Promise.all([Workspace.preload?.(), Route.preload?.()]);
export const NeedsReviewRoute = (): JSX.Element => <Route />;
