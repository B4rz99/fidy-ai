import type * as React from "react";
import { cn } from "@/ui/class-names";
import { Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type SpinnerProps = Omit<React.ComponentProps<typeof HugeiconsIcon>, "icon" | "strokeWidth">;

const Spinner = ({ className, ...props }: SpinnerProps): React.JSX.Element => (
  <HugeiconsIcon
    aria-hidden="true"
    className={cn("size-5 animate-spin motion-reduce:animate-none", className)}
    data-slot="spinner"
    icon={Loading03Icon}
    strokeWidth={1.5}
    {...props}
  />
);
export { Spinner };
