import { BigDecimal, DateTime } from "effect";
import type { JSX } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/ui/components/card";
import {
  type Category,
  type Occurrence,
  type Workspace,
  expectedAmount,
  kinds,
  money,
  statuses,
} from "./model";

export const Summary = ({ view }: Readonly<{ view: Workspace }>): JSX.Element => (
  <div className="grid gap-4 md:grid-cols-3">
    {kinds.map(([kind, label]) => (
      <section key={kind} aria-label={label}>
        <Card>
          <CardHeader>
            <CardTitle>{label}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {view.summary
              .filter((group) => group.kind === kind)
              .map((group) => (
                <div key={group.currency} className="grid gap-1">
                  <span className="font-medium">{group.currency}</span>
                  <span>{money(group.completed)} registrados</span>
                  <span>{money(group.remaining)} restantes</span>
                  {BigDecimal.isZero(group.estimated.amount) ? null : (
                    <span className="text-muted-foreground">{money(group.estimated)} estimado</span>
                  )}
                  {group.unknown > 0 ? <span>{group.unknown} por confirmar</span> : null}
                </div>
              ))}
            {view.summary.some((group) => group.kind === kind) ? null : (
              <p className="text-muted-foreground">Sin recurrentes este mes</p>
            )}
          </CardContent>
        </Card>
      </section>
    ))}
  </div>
);
export const OccurrenceButton = ({
  item,
  open,
  categories,
}: Readonly<{
  item: Occurrence;
  categories: ReadonlyArray<Category>;
  open: (item: Occurrence) => void;
}>): JSX.Element => (
  <button
    type="button"
    className="flex h-auto w-full items-center justify-between gap-3 rounded-none border-b px-4 py-4 text-left whitespace-normal transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
    onClick={() => open(item)}
  >
    <span className="min-w-0">
      <span className="block font-medium">{item.plan.name}</span>
      <span className="block text-xs text-muted-foreground">
        {item.expectedDate} · {statuses[item.status]}
        {item.plan.cardPayment === true ? " · Pago de tarjeta" : ""}
      </span>
    </span>
    <span className="hidden text-sm text-muted-foreground lg:block">
      {categories.find((category) => category.id === item.plan.categoryId)?.label ??
        "Sin categoría"}
    </span>
    <span className="shrink-0 text-right text-sm">{expectedAmount(item)}</span>
  </button>
);
export const OccurrenceList = ({
  items,
  open,
  categories,
}: Readonly<{
  items: ReadonlyArray<Occurrence>;
  categories: ReadonlyArray<Category>;
  open: (item: Occurrence) => void;
}>): JSX.Element => (
  <div className="grid gap-5">
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
        <section key={status} className="overflow-hidden rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 font-medium">
            {label} · {selected.length}
          </h2>
          {selected.map((item) => (
            <OccurrenceButton
              key={`${item.planId}:${item.date}`}
              item={item}
              open={open}
              categories={categories}
            />
          ))}
        </section>
      );
    })}
  </div>
);
const dayDigits = 2;
const weekLength = 7;
const calendarCells = 42;
export const MonthCalendar = ({
  view,
  open,
  categories,
}: Readonly<{
  view: Workspace;
  categories: ReadonlyArray<Category>;
  open: (item: Occurrence) => void;
}>): JSX.Element => {
  const first = DateTime.makeUnsafe(`${view.month}-01`);
  const offset = (DateTime.toPartsUtc(first).weekDay + weekLength - 1) % weekLength;
  const start = DateTime.subtract(first, { days: offset });
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <div className="grid min-w-[42rem] grid-cols-7">
        {["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((day) => (
          <div key={day} className="border-b p-3 text-center text-sm text-muted-foreground">
            {day}
          </div>
        ))}
        {Array.from({ length: calendarCells }, (_, index) => {
          const date = DateTime.formatIsoDateUtc(DateTime.add(start, { days: index }));
          return (
            <section
              key={date}
              aria-label={date}
              className="min-h-28 min-w-0 border-r border-b p-2"
            >
              <p
                className={
                  date.startsWith(view.month) ? "text-sm" : "text-sm text-muted-foreground"
                }
              >
                {Number(date.slice(-dayDigits))}
              </p>
              {view.occurrences
                .filter((item) => item.expectedDate === date)
                .map((item) => (
                  <OccurrenceButton
                    key={`${item.planId}:${item.date}`}
                    item={item}
                    open={open}
                    categories={categories}
                  />
                ))}
            </section>
          );
        })}
      </div>
    </div>
  );
};
