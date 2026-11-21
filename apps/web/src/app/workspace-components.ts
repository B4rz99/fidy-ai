import { lazyRouteComponent } from "@tanstack/react-router";
import { Option } from "effect";
import { memo } from "react";

export { NeedsReviewFeature as ReviewWorkspace } from "@/features/needs-review/feature";

export const RecurringWorkspace = lazyRouteComponent(() =>
  import("@/features/recurring/feature").then((module) => ({
    default: memo(
      module.RecurringFeature,
      (before, after) => Option.getOrUndefined(before.month) === Option.getOrUndefined(after.month)
    ),
  }))
);
