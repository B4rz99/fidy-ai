import type { JSX, ReactNode } from "react";
import { cn } from "@/ui/class-names";
import "./financial-summary-card.css";

const characterWidth = 1.6;
/** Presents formatted financial text without interpreting or calculating Money. */
export const FinancialSummaryCard = ({
  amount,
  label,
  tone,
  children,
  ariaLabel,
}: Readonly<{
  amount: string;
  label: string;
  tone: "positive" | "negative";
  children: ReactNode;
  ariaLabel: string;
}>): JSX.Element => (
  <section
    aria-label={ariaLabel}
    className="financial-summary-card overflow-hidden rounded-lg border bg-card"
  >
    <div
      className={cn(
        "mx-4 mt-4 rounded-md px-3 py-6 text-center",
        tone === "negative"
          ? "bg-destructive/25 text-destructive-foreground"
          : "bg-success/25 text-ring"
      )}
    >
      <p
        className="financial-summary-amount font-semibold tabular-nums"
        style={{
          fontSize: `clamp(var(--text-base), calc(85cqi / ${Math.max(amount.length, 1)} * ${characterWidth}), var(--text-3xl))`,
        }}
      >
        {amount}
      </p>
      <p className="mt-2 text-sm font-medium">{label}</p>
    </div>
    {children}
  </section>
);
