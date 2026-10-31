import type { JSX, ReactNode } from "react";
import { buttonVariants } from "./button-variants";
import { Skeleton } from "./skeleton";

type Props = Readonly<{ size: "icon-sm" } | { size: "sm"; children: ReactNode }>;

export const RecurringControlSkeleton = (props: Props): JSX.Element => (
  <Skeleton
    data-slot="button"
    className={buttonVariants({
      size: props.size,
      variant: "ghost",
      focusAppearance: "subtle",
      contentLayout: "wrap",
      className: "bg-muted",
    })}
  >
    {props.size === "sm" && (
      <span className="invisible inline-flex items-center gap-1">{props.children}</span>
    )}
  </Skeleton>
);
