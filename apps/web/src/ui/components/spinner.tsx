import type * as React from "react";
import { Loader2Icon } from "lucide-react";
import { cn } from "@/ui/class-names";

const Spinner = ({ className, ...props }: React.ComponentProps<"svg">): React.JSX.Element => (
  <Loader2Icon
    aria-hidden="true"
    className={cn("size-4 animate-spin", className)}
    data-slot="spinner"
    {...props}
  />
);
export { Spinner };
