import { useRouterState } from "@tanstack/react-router";
import { DateTime, Option } from "effect";
import { type JSX, useMemo, useState } from "react";
import { cn } from "@/ui/class-names";
import { Button } from "@/ui/components/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/ui/components/sheet";
import { OccurrencePages } from "./pagination";
import { useOccurrencePage } from "./use-occurrence-page";
import { type Occurrence, type Workspace, expectedAmount, statuses } from "./model";

type CalendarProps = Readonly<{ view: Workspace; open: (item: Occurrence) => void }>;
type DayProps = Readonly<{
  date: string;
  items: ReadonlyArray<Occurrence>;
  today: string;
  open: CalendarProps["open"];
  agenda: (date: string) => void;
}>;
const dayDigits = 2;
const weekLength = 7;
const calendarCells = 42;
const dayPreviewSize = 3;
const CalendarItem = ({
  item,
  open,
}: Readonly<{ item: Occurrence; open: CalendarProps["open"] }>): JSX.Element => (
  <button
    type="button"
    onClick={() => open(item)}
    title={`${item.plan.name} · ${expectedAmount(item)} · ${statuses[item.status]}`}
    className={cn(
      "grid w-full min-w-0 gap-1 rounded-md p-2 text-left text-xs outline-none hover:bg-secondary focus-visible:bg-secondary focus-visible:underline",
      item.plan.kind === "income" ? "bg-success/25" : "bg-muted/60"
    )}
  >
    <span className="line-clamp-2 font-medium [overflow-wrap:anywhere]">{item.plan.name}</span>
    <span className="tabular-nums">{expectedAmount(item)}</span>
    <span className="sr-only">
      {item.expectedDate} · {statuses[item.status]}
    </span>
    {item.status === "upcoming" ? null : (
      <span className="text-muted-foreground">{statuses[item.status]}</span>
    )}
  </button>
);
const DayItems = ({ date, items, open, agenda }: DayProps): JSX.Element => (
  <div className="grid min-w-0 gap-1">
    {items.slice(0, dayPreviewSize).map((item) => (
      <CalendarItem key={`${item.planId}:${item.date}`} item={item} open={open} />
    ))}
    {items.length > dayPreviewSize ? (
      <Button
        contentLayout="wrap"
        size="sm"
        variant="ghost"
        focusAppearance="subtle"
        aria-label={`+${items.length - dayPreviewSize} más · Ver ${items.length} recurrentes del ${date}`}
        onClick={() => agenda(date)}
      >
        +{items.length - dayPreviewSize} más
      </Button>
    ) : null}
  </div>
);
const CalendarDay = (props: DayProps & Readonly<{ month: string }>): JSX.Element => (
  <section
    aria-label={props.date}
    className={cn(
      "flex min-h-32 min-w-0 flex-col gap-2 border-r border-b p-2",
      !props.date.startsWith(props.month) && "bg-muted/20"
    )}
  >
    <span
      className={cn(
        "flex size-6 items-center justify-center self-end rounded-full text-xs",
        props.date === props.today && "bg-primary text-primary-foreground"
      )}
      aria-current={props.date === props.today ? "date" : undefined}
    >
      {Number(props.date.slice(-dayDigits))}
    </span>
    <DayItems {...props} />
  </section>
);
const DayAgenda = ({ date, items, open }: Omit<DayProps, "today" | "agenda">): JSX.Element => {
  const page = useOccurrencePage(items);
  return (
    <>
      <SheetHeader>
        <SheetTitle>Recurrentes del {date}</SheetTitle>
      </SheetHeader>
      <div className="grid min-w-0 gap-2 px-4">
        {page.items.map((item) => (
          <CalendarItem key={`${item.planId}:${item.date}`} item={item} open={open} />
        ))}
      </div>
      <OccurrencePages page={page} total={items.length} label={date} />
    </>
  );
};
const CalendarGrid = ({
  view,
  open,
  agenda,
  days,
}: CalendarProps &
  Pick<DayProps, "agenda"> &
  Readonly<{ days: ReadonlyMap<string, ReadonlyArray<Occurrence>> }>): JSX.Element => {
  const first = DateTime.makeUnsafe(`${view.month}-01`);
  const offset = (DateTime.toPartsUtc(first).weekDay + weekLength - 1) % weekLength;
  const start = DateTime.subtract(first, { days: offset });
  return (
    <div className="hidden grid-cols-7 @min-5xl:grid">
      {["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((day) => (
        <div key={day} className="border-b p-3 text-center text-xs text-muted-foreground">
          {day}
        </div>
      ))}
      {Array.from({ length: calendarCells }, (_, index) => {
        const date = DateTime.formatIsoDateUtc(DateTime.add(start, { days: index }));
        return (
          <CalendarDay
            key={date}
            date={date}
            items={days.get(date) ?? []}
            today={view.today}
            month={view.month}
            open={open}
            agenda={agenda}
          />
        );
      })}
    </div>
  );
};
const dayLabel = (date: string): string =>
  DateTime.format(DateTime.makeUnsafe(date), {
    locale: "es-CO",
    dateStyle: "full",
    timeZone: "UTC",
  });

const CalendarAgenda = ({
  days,
  today,
  open,
  agenda,
}: Pick<DayProps, "today" | "open" | "agenda"> &
  Readonly<{ days: ReadonlyMap<string, ReadonlyArray<Occurrence>> }>): JSX.Element => (
  <div className="divide-y @min-5xl:hidden">
    {Array.from(days.keys())
      .sort()
      .map((date) => (
        <section key={date} aria-label={date} className="grid min-w-0 gap-3 p-3">
          <h3 className="text-sm font-medium">{dayLabel(date)}</h3>
          <DayItems
            date={date}
            items={days.get(date) ?? []}
            today={today}
            open={open}
            agenda={agenda}
          />
        </section>
      ))}
  </div>
);

export const MonthCalendar = ({ view, open }: CalendarProps): JSX.Element => {
  const active = useRouterState({
    select: (state) => state.location.pathname === "/app/recurring",
  });
  const [selected, setSelected] = useState<Option.Option<string>>(() => Option.none());
  const changeAgenda = (opened: boolean): void => {
    if (!opened) setSelected(Option.none());
  };
  const agenda = (date: string): void => setSelected(Option.some(date));
  const openItem = (item: Occurrence): void => {
    setSelected(Option.none());
    open(item);
  };
  const days = useMemo(
    () => Map.groupBy(view.occurrences, (item) => item.expectedDate),
    [view.occurrences]
  );
  return (
    <div
      data-recurring-slot="calendar"
      className="@container min-w-0"
      aria-label="Calendario de recurrentes"
    >
      <CalendarGrid view={view} open={open} agenda={agenda} days={days} />
      <CalendarAgenda days={days} today={view.today} open={open} agenda={agenda} />
      <Sheet
        open={active && Option.isSome(selected)}
        onOpenChangeComplete={changeAgenda}
        onOpenChange={changeAgenda}
      >
        <SheetContent
          aria-hidden={!active || Option.isNone(selected)}
          side="right"
          showCloseButton
          appearance="application"
          className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
        >
          {Option.isSome(selected) ? (
            <DayAgenda
              key={selected.value}
              date={selected.value}
              items={days.get(selected.value) ?? []}
              open={openItem}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
};
