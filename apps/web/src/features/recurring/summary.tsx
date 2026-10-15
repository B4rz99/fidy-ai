import { BigDecimal } from "effect";
import type { JSX } from "react";
import { Progress } from "@/ui/components/progress";
import { type Workspace, kinds, money, transferLabel } from "./model";

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
  <div className="grid gap-2">
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
      <span>{group.currency}</span>
      <span>
        {group.unknown > 0
          ? `${group.unknown} por confirmar`
          : `${money({ ...group.completed, amount: BigDecimal.sum(group.completed.amount, group.remaining.amount) })} previstos`}
      </span>
    </div>
    <Progress value={progress(group)} aria-label={`${label} registrados en ${group.currency}`} />
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs tabular-nums">
      <span>{money(group.completed)} registrados</span>
      <span className="text-muted-foreground">{money(group.remaining)} restantes</span>
    </div>
  </div>
);
export const Summary = ({ view }: Readonly<{ view: Workspace }>): JSX.Element => (
  <div className="grid gap-y-2 @min-5xl:grid-cols-3">
    {kinds.map(([kind, label]) => (
      <section key={kind} aria-label={label} className="grid min-w-0 content-start gap-3 px-2 py-4">
        <h3 className="text-sm font-medium">
          {kind === "transfer" ? transferLabel(view.occurrences) : label}
        </h3>
        {view.summary
          .filter((group) => group.kind === kind)
          .map((group) => (
            <SummaryAmounts key={group.currency} group={group} label={label} />
          ))}
        {view.summary.some((group) => group.kind === kind) ? null : (
          <p className="text-xs text-muted-foreground">Sin recurrentes este mes</p>
        )}
      </section>
    ))}
  </div>
);
