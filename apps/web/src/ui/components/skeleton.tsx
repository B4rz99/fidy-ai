import * as React from "react";
import { cn } from "@/ui/class-names";

type SkeletonProps = React.ComponentProps<"div">;

const Skeleton = ({ className, ...props }: SkeletonProps): React.JSX.Element => (
  <div
    data-slot="skeleton"
    className={cn("animate-pulse rounded-md bg-muted", className)}
    {...props}
  />
);

export { Skeleton };
