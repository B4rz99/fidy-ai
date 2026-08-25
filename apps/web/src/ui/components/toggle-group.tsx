"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import type { JSX } from "react";
import { cn } from "@/ui/class-names";

const ToggleGroup = ({ className, ...props }: ToggleGroupPrimitive.Props): JSX.Element => (
  <ToggleGroupPrimitive
    className={cn("flex w-fit flex-row flex-wrap items-center gap-2 rounded-lg", className)}
    data-slot="toggle-group"
    {...props}
  />
);

const ToggleGroupItem = ({ className, ...props }: TogglePrimitive.Props): JSX.Element => (
  <TogglePrimitive
    className={cn(
      "inline-flex h-9 min-w-9 shrink-0 items-center justify-center rounded-lg border border-input bg-transparent px-3 text-sm font-medium whitespace-nowrap transition-all outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-primary aria-pressed:text-primary-foreground",
      className
    )}
    data-slot="toggle-group-item"
    {...props}
  />
);

export { ToggleGroup, ToggleGroupItem };
