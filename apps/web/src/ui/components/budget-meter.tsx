import type { JSX } from "react";
import { Progress } from "./progress";
import { cn } from "@/ui/class-names";

/** Budget spending ratio with a semantic over-cap treatment and an explicit accessible label. */
export const BudgetMeter = ({
  value,
  over,
  label,
  variant,
}: Readonly<{
  value: number;
  over: boolean;
  label: string;
  variant: "default" | "summary";
}>): JSX.Element => (
  <Progress
    value={value}
    aria-label={label}
    className={cn(
      variant === "summary" &&
        "[&_[data-slot=progress-track]]:h-2 [&_[data-slot=progress-track]]:bg-foreground/10",
      variant === "summary"
        ? "[&_[data-slot=progress-indicator]]:bg-primary"
        : "[&_[data-slot=progress-indicator]]:bg-primary",
      over && "[&_[data-slot=progress-indicator]]:bg-destructive"
    )}
  />
);

/** Color accompanies the remaining/overage label rather than carrying meaning alone. */
export const BudgetBalance = ({
  over,
  children,
}: Readonly<{ over: boolean; children: string }>): JSX.Element => (
  <span
    className={cn(
      "inline-flex rounded-full px-2.5 py-1 text-sm font-medium tabular-nums",
      over ? "bg-destructive text-destructive-foreground" : "bg-success/30 text-foreground"
    )}
  >
    {children}
  </span>
);
