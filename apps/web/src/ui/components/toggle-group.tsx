"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { type VariantProps, cva } from "class-variance-authority";
import type { JSX } from "react";
import { cn } from "@/ui/class-names";

const ToggleGroup = ({ className, ...props }: ToggleGroupPrimitive.Props): JSX.Element => (
  <ToggleGroupPrimitive
    className={cn("flex w-fit flex-row flex-wrap items-center gap-2 rounded-lg", className)}
    data-slot="toggle-group"
    {...props}
  />
);

const itemVariants = cva(
  "inline-flex h-9 min-w-9 shrink-0 items-center justify-center px-3 text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "rounded-lg border border-input bg-transparent hover:bg-muted hover:text-foreground focus-visible:border-ring aria-pressed:bg-primary aria-pressed:text-primary-foreground",
        summary:
          "rounded-full border-0 bg-transparent text-muted-foreground hover:bg-foreground/5 aria-pressed:bg-foreground/5 aria-pressed:text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

const ToggleGroupItem = ({
  className,
  variant,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof itemVariants>): JSX.Element => (
  <TogglePrimitive
    className={cn(itemVariants({ variant }), className)}
    data-slot="toggle-group-item"
    {...props}
  />
);

export { ToggleGroup, ToggleGroupItem };
