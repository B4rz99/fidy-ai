import { RecurringOccurrenceColumns } from "@/ui/components/recurring-occurrence-columns";
import { BigDecimal, DateTime } from "effect";
import { type JSX, useState } from "react";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { OccurrencePages } from "./pagination";
import { useOccurrencePage } from "./use-occurrence-page";
import { InlineRecurringCategory } from "./inline-category";
import { RecurringIdentity } from "./visuals";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/table";
import {
  type Category,
  type Occurrence,
  type Save,
  expectedAmount,
  kinds,
  money,
  statuses,
  transferLabel,
} from "./model";

type ListProps = Readonly<{
  items: ReadonlyArray<Occurrence>;
  categories: ReadonlyArray<Category>;
  open: (item: Occurrence) => void;
  today: string;
  save: Save;
  disabled: boolean;
}>;
type ItemProps = Omit<ListProps, "items"> & Readonly<{ item: Occurrence }>;
const dateLabel = (date: string, today: string): string =>
  date === today
    ? "Hoy"
    : DateTime.format(DateTime.makeUnsafe(date), {
        locale: "es-CO",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      });
const DesktopItem = ({ item, open, categories, today, save, disabled }: ItemProps): JSX.Element => (
  <TableRow
    tabIndex={0}
    aria-label={`${item.plan.name} ${item.expectedDate} · ${statuses[item.status]} ${expectedAmount(item)}`}
    interaction="clickable"
    onClick={(event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("button, a, [role=menuitemradio]") !== null
      ) {
        return;
      }
      open(item);
    }}
    onKeyDown={(event) => {
      if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
        return;
      }
      event.preventDefault();
      open(item);
    }}
  >
    <TableCell density="compact">
      <RecurringIdentity plan={item.plan} />
    </TableCell>
    <TableCell density="compact">
      <span className="whitespace-nowrap">{dateLabel(item.expectedDate, today)}</span>
      {item.status === "partial" ? (
        <span className="block text-xs text-muted-foreground">Parcial</span>
      ) : null}
    </TableCell>
    <TableCell density="compact">
      <span className="text-muted-foreground">
        {item.plan.accountId === undefined ? "Sin cuenta asignada" : "Cuenta vinculada"}
      </span>
    </TableCell>
    <TableCell density="compact">
      <InlineRecurringCategory
        item={item}
        categories={categories}
        save={save}
        disabled={disabled}
      />
    </TableCell>
    <TableCell density="compact" className="text-right tabular-nums">
      {expectedAmount(item)}
    </TableCell>
  </TableRow>
);
const DesktopList = ({ items, ...props }: ListProps): JSX.Element => (
  <div className="hidden @min-5xl:block">
    <Table layout="fixed">
      <RecurringOccurrenceColumns />
      <TableHeader>
        <TableRow>
          {["Recurrente", "Fecha", "Cuenta de pago", "Categoría", "Importe"].map((label) => (
            <TableHead
              key={label}
              scope="col"
              density="compact"
              className={label === "Importe" ? "text-right" : ""}
            >
              {label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <DesktopItem key={`${item.planId}:${item.date}`} item={item} {...props} />
        ))}
      </TableBody>
    </Table>
  </div>
);
const MobileList = ({ items, open, today }: ListProps): JSX.Element => (
  <div className="divide-y @min-5xl:hidden">
    {items.map((item) => (
      <button
        type="button"
        key={`${item.planId}:${item.date}`}
        onClick={() => open(item)}
        className="grid w-full min-w-0 gap-3 px-4 py-3 @min-2xl:grid-cols-[minmax(0,1fr)_auto] text-left hover:bg-muted focus-visible:bg-muted focus-visible:underline"
      >
        <span className="min-w-0">
          <RecurringIdentity plan={item.plan} />
          <span className="mt-1 block pl-12 text-xs text-muted-foreground">
            {dateLabel(item.expectedDate, today)} · {statuses[item.status]}
          </span>
        </span>
        <span className="min-w-0 text-xs tabular-nums @min-2xl:text-right">
          {expectedAmount(item)}
        </span>
      </button>
    ))}
  </div>
);
const GroupTotals = ({ items }: Pick<ListProps, "items">): JSX.Element => (
  <footer
    aria-label="Total de próximos"
    className="flex flex-wrap items-center justify-between gap-4 border-t bg-muted/40 px-5 py-3"
  >
    <div className="text-sm font-medium">Total de próximos</div>
    <div className="flex flex-wrap gap-x-8 gap-y-3">
      {kinds.map(([kind, label]) => {
        const selected = items.filter((item) => item.plan.kind === kind);
        return (
          <div key={kind} className="grid gap-1 text-right text-xs">
            <span className="text-muted-foreground">
              {kind === "transfer" ? transferLabel(selected) : label}
            </span>
            {[...new Set(selected.map((item) => item.plan.currency))].map((currency) => {
              const sameCurrency = selected.filter((item) => item.plan.currency === currency);
              const amount = BigDecimal.sumAll(
                sameCurrency.flatMap((item) =>
                  item.remaining === undefined ? [] : [item.remaining.amount]
                )
              );
              return (
                <span key={currency} className="font-medium tabular-nums">
                  {money({ currency, amount })}
                  {sameCurrency.some((item) => item.plan.money === undefined)
                    ? " + por confirmar"
                    : ""}
                </span>
              );
            })}
            {selected.length === 0 ? <span>—</span> : null}
          </div>
        );
      })}
    </div>
  </footer>
);
const OccurrenceGroup = ({
  label,
  ...props
}: ListProps & Readonly<{ label: string }>): JSX.Element => {
  const [expanded, setExpanded] = useState(true);
  const page = useOccurrencePage(props.items);
  return (
    <section data-recurring-slot="occurrence-group" className="@container min-w-0">
      <h2>
        <button
          type="button"
          className="flex w-full items-center gap-2 border-b px-5 py-3 text-left text-sm font-medium hover:bg-muted focus-visible:bg-muted focus-visible:underline"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <HugeiconsIcon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} className="size-4" />
          {label}
          <span className="text-xs text-muted-foreground">{props.items.length}</span>
        </button>
      </h2>
      {expanded ? (
        <>
          <DesktopList {...props} items={page.items} />
          <MobileList {...props} items={page.items} />
          <OccurrencePages page={page} total={props.items.length} label={label} />
          {label === "Próximos" ? <GroupTotals items={props.items} /> : null}
        </>
      ) : null}
    </section>
  );
};
export const OccurrenceList = ({ items, ...props }: ListProps): JSX.Element => (
  <div className="grid gap-4">
    {(
      [
        ["upcoming", "Próximos"],
        ["unconfirmed", "Sin confirmar"],
        ["completed", "Completados"],
        ["skipped", "Omitidos"],
      ] as const
    ).map(([status, label]) => {
      const selected = items.filter(
        (item) => item.status === status || (status === "unconfirmed" && item.status === "partial")
      );
      return selected.length === 0 ? null : (
        <OccurrenceGroup
          key={`${status}:${selected.map((item) => `${item.planId}:${item.date}`).join(",")}`}
          label={label}
          items={selected}
          {...props}
        />
      );
    })}
  </div>
);
