import * as React from "react";

import { cn } from "@/ui/class-names";

type LabelProps = React.ComponentProps<"label"> & Readonly<{ htmlFor: string }>;

const Label = ({ className, htmlFor, ...props }: LabelProps): React.JSX.Element => (
  <label
    data-slot="label"
    htmlFor={htmlFor}
    className={cn(
      "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
      className
    )}
    {...props}
  />
);

export { Label };
