import { browserRuntime } from "@/transport/browser-runtime";
import { Effect } from "effect";
import { preloadReviewMaterial, prepareReviewWorkspace } from "./query";
import { lazyRouteComponent } from "@tanstack/react-router";
import { type ComponentProps, type JSX, memo } from "react";

export { ReviewPendingCount } from "./navigation";

const Workspace = lazyRouteComponent(() =>
  import("./workspace").then((module) => ({ default: memo(module.NeedsReviewFeature) }))
);

const PreviewWorkspace = import.meta.env.DEV
  ? lazyRouteComponent(() =>
      import("./dev-preview").then((module) => ({
        default: memo(module.NeedsReviewDataPreview),
      }))
    )
  : Workspace;

const Route = lazyRouteComponent(() => import("./workspace"), "NeedsReviewRoute");

export const NeedsReviewFeature = (props: ComponentProps<typeof Workspace>): JSX.Element => (
  <PreviewWorkspace {...props} />
);

NeedsReviewFeature.preload = (): Promise<void> =>
  browserRuntime.runPromise(
    Effect.asVoid(Effect.tryPromise(() => Promise.all([Workspace.preload?.(), Route.preload?.()])))
  );

NeedsReviewFeature.preloadData = prepareReviewWorkspace;

NeedsReviewFeature.preloadMaterial = preloadReviewMaterial;

export const NeedsReviewRoute = (): JSX.Element => <Route />;
