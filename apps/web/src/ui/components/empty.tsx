import * as React from "react";
import { type VariantProps, cva } from "class-variance-authority";
import { cn } from "@/ui/class-names";

type DivProps = React.ComponentProps<"div">;

const Empty = ({ className, ...props }: DivProps): React.JSX.Element => (
  <div
    data-slot="empty"
    className={cn(
      "flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-xl border-dashed p-6 text-center text-balance",
      className
    )}
    {...props}
  />
);

const EmptyHeader = ({ className, ...props }: DivProps): React.JSX.Element => (
  <div
    data-slot="empty-header"
    className={cn("flex max-w-sm flex-col items-center gap-2", className)}
    {...props}
  />
);

const emptyMediaVariants = cva(
  "mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

type EmptyMediaProps = DivProps & VariantProps<typeof emptyMediaVariants>;

const EmptyMedia = ({
  className,
  variant = "default",
  ...props
}: EmptyMediaProps): React.JSX.Element => (
  <div
    data-slot="empty-icon"
    data-variant={variant}
    className={cn(emptyMediaVariants({ variant, className }))}
    {...props}
  />
);

const EmptyTitle = ({ className, ...props }: DivProps): React.JSX.Element => (
  <div
    data-slot="empty-title"
    className={cn("font-heading text-sm font-medium tracking-tight", className)}
    {...props}
  />
);

const EmptyDescription = ({ className, ...props }: DivProps): React.JSX.Element => (
  <div
    data-slot="empty-description"
    className={cn(
      "text-sm/relaxed text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
      className
    )}
    {...props}
  />
);

const EmptyContent = ({ className, ...props }: DivProps): React.JSX.Element => (
  <div
    data-slot="empty-content"
    className={cn(
      "flex w-full max-w-sm min-w-0 flex-col items-center gap-2.5 text-sm text-balance",
      className
    )}
    {...props}
  />
);

export { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle };
