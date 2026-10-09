import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "@/ui/class-names";

const Input = ({ className, type, ...props }: React.ComponentProps<"input">): React.JSX.Element => (
  <InputPrimitive
    type={type}
    data-slot="input"
    className={cn(
      "min-h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2.5 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-foreground aria-invalid:ring-3 aria-invalid:ring-ring",
      className
    )}
    {...props}
  />
);

export { Input };
