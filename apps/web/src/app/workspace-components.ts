import { lazyRouteComponent } from "@tanstack/react-router";
import { Option } from "effect";
import { memo } from "react";

/** Routes preload the same presentations that the application retains after navigation. */
export const ReviewWorkspace = lazyRouteComponent(() =>
  import("@/features/needs-review/feature").then((module) => ({
    default: memo(module.NeedsReviewFeature),
  }))
);
export const RecurringWorkspace = lazyRouteComponent(() =>
  import("@/features/recurring/feature").then((module) => ({
    default: memo(
      module.RecurringFeature,
      (before, after) => Option.getOrUndefined(before.month) === Option.getOrUndefined(after.month)
    ),
  }))
);
