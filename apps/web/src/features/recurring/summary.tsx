import { BigDecimal } from "effect";
import type { JSX } from "react";
import { Progress } from "@/ui/components/progress";
import { ArrowDown01Icon, ArrowUp01Icon, CreditCardIcon } from "@hugeicons/core-free-icons";
import { IconIndicator } from "@/ui/components/icon-indicator";
import { type Workspace, kinds, money, transferLabel } from "./model";

const indicators = {
  income: { icon: ArrowUp01Icon, tone: "sage" },
  expense: { icon: ArrowDown01Icon, tone: "peach" },
  transfer: { icon: CreditCardIcon, tone: "lavender" },
} as const;

type SummaryGroup = Workspace["summary"][number];
const percentageScale = 100;
const progress = (group: SummaryGroup): number => {
  const total = BigDecimal.sum(group.completed.amount, group.remaining.amount);
  if (BigDecimal.isZero(total)) return 0;
  return Math.min(
    percentageScale,
    BigDecimal.toNumberUnsafe(BigDecimal.divideUnsafe(group.completed.amount, total)) *
      percentageScale
  );
};
const SummaryAmounts = ({
  group,
  label,
}: Readonly<{ group: SummaryGroup; label: string }>): JSX.Element => (
  <div data-recurring-slot="summary-amounts" className="grid gap-2">
    <div data-recurring-slot="summary-planned">
      <span>{group.currency}</span>
      {group.unknown > 0 ? (
        <span data-recurring-slot="unknown-amount">{group.unknown} por confirmar</span>
      ) : (
        <>
          <strong>
            {money({
              ...group.completed,
              amount: BigDecimal.sum(group.completed.amount, group.remaining.amount),
            })}
          </strong>
          <span>previstos</span>
        </>
      )}
    </div>
    <Progress value={progress(group)} aria-label={`${label} registrados en ${group.currency}`} />
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs tabular-nums">
      <span>{money(group.completed)} registrados</span>
      <span className="text-muted-foreground">{money(group.remaining)} restantes</span>
    </div>
  </div>
);
export const Summary = ({ view }: Readonly<{ view: Workspace }>): JSX.Element => (
  <div data-recurring-slot="summary">
    {kinds.map(([kind, label]) => (
      <section key={kind} aria-label={label} data-recurring-slot="summary-kind">
        <h3>
          <IconIndicator
            icon={indicators[kind].icon}
            tone={indicators[kind].tone}
            appearance="category"
          />
          {kind === "transfer" ? transferLabel(view.occurrences) : label}
        </h3>
        {view.summary.map((group) =>
          group.kind === kind ? (
            <SummaryAmounts key={group.currency} group={group} label={label} />
          ) : null
        )}
        {view.summary.some((group) => group.kind === kind) ? null : (
          <p className="text-xs text-muted-foreground">Sin recurrentes este mes</p>
        )}
      </section>
    ))}
  </div>
);
