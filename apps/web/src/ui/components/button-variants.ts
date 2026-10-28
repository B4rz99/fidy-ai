import { cva } from "class-variance-authority";

export const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition-colors outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:border-disabled-border disabled:bg-disabled disabled:text-disabled-foreground aria-invalid:border-foreground aria-invalid:ring-3 aria-invalid:ring-ring [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5",
  {
    variants: {
      variant: {
        default:
          "border-primary-border bg-primary text-primary-foreground hover:border-primary-hover-border hover:bg-primary-hover active:border-primary-pressed-border active:bg-primary-pressed",
        outline:
          "border-control-border bg-transparent hover:bg-control-hover hover:text-foreground active:bg-control-pressed aria-expanded:bg-control-pressed aria-expanded:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        view: "hover:bg-muted aria-pressed:bg-secondary aria-pressed:text-secondary-foreground focus-visible:border-transparent focus-visible:bg-secondary focus-visible:ring-0 focus-visible:underline focus-visible:underline-offset-4",
        disclosure: "hover:bg-muted hover:text-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:border-destructive focus-visible:ring-destructive disabled:bg-destructive disabled:text-destructive-foreground",
        "destructive-outline":
          "border-error-foreground bg-transparent text-error-foreground hover:bg-error-subtle active:bg-error-subtle",
        "destructive-text":
          "bg-transparent text-error-foreground hover:bg-error-subtle active:bg-error-subtle",
        link: "text-foreground underline underline-offset-4 hover:text-muted-foreground",
      },
      contentLayout: {
        singleLine: "",
        wrap: "h-auto min-w-0 max-w-full shrink whitespace-normal [overflow-wrap:anywhere]",
      },
      focusAppearance: {
        ring: "",
        subtle:
          "focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-0 focus-visible:bg-muted focus-visible:underline focus-visible:underline-offset-4",
      },
      size: {
        label: "min-h-11 gap-2 px-0 py-2.5 [&_svg:not([class*='size-'])]:size-4",
        offer:
          "h-auto min-h-12 min-w-0 max-w-full flex-wrap gap-x-1 gap-y-1 px-2 py-6 font-heading text-base font-semibold tabular-nums sm:px-6 sm:text-xl",
        default:
          "min-h-11 gap-2 px-5 py-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "min-h-12 gap-2 px-6 py-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-11",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-12",
      },
    },
    compoundVariants: [
      { contentLayout: "wrap", size: "xs", className: "h-auto min-h-6" },
      { contentLayout: "wrap", size: "sm", className: "h-auto min-h-7" },
      {
        variant: "destructive",
        focusAppearance: "subtle",
        className: "focus-visible:bg-destructive focus-visible:text-destructive-foreground",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);
