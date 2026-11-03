import { useRouterState } from "@tanstack/react-router";
import { DateTime, Option } from "effect";
import { type JSX, useState } from "react";
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
    data-recurring-slot="calendar-day"
    className={cn(
      "flex min-w-0 flex-col border-r border-b @min-5xl:min-h-32 @min-5xl:gap-2 @min-5xl:p-2",
      !props.date.startsWith(props.month) && "bg-muted/20"
    )}
  >
    {props.date.startsWith(props.month) ? (
      <Button
        data-recurring-slot="calendar-day-trigger"
        variant="ghost"
        aria-label={`${Number(props.date.slice(-dayDigits))} · ${props.items.length === 1 ? "1 recurrente" : `${props.items.length} recurrentes`} · ${dayLabel(props.date)}`}
        aria-haspopup="dialog"
        aria-current={props.date === props.today ? "date" : undefined}
        onClick={() => props.agenda(props.date)}
        className="@min-5xl:hidden"
      >
        <span>{Number(props.date.slice(-dayDigits))}</span>{" "}
        {props.items.length > 0 ? (
          <span data-recurring-slot="calendar-day-count">{props.items.length}</span>
        ) : null}
      </Button>
    ) : (
      <span data-recurring-slot="calendar-outside-day" className="@min-5xl:hidden">
        {Number(props.date.slice(-dayDigits))}
      </span>
    )}
    <span
      className={cn(
        "hidden size-6 items-center justify-center self-end rounded-full text-xs @min-5xl:flex",
        props.date === props.today && "bg-primary text-primary-foreground"
      )}
      aria-current={props.date === props.today ? "date" : undefined}
    >
      {Number(props.date.slice(-dayDigits))}
    </span>
    <div className="hidden @min-5xl:block">
      <DayItems {...props} />
    </div>
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
        {items.length === 0 ? <p>Sin recurrentes para este día.</p> : null}
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
}: CalendarProps & Pick<DayProps, "agenda">): JSX.Element => {
  const first = DateTime.makeUnsafe(`${view.month}-01`);
  const offset = (DateTime.toPartsUtc(first).weekDay + weekLength - 1) % weekLength;
  const start = DateTime.subtract(first, { days: offset });
  return (
    <div className="grid grid-cols-7">
      {["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((day) => (
        <div key={day} className="border-b py-3 text-center text-xs text-muted-foreground">
          {day}
        </div>
      ))}
      {Array.from({ length: calendarCells }, (_, index) => {
        const date = DateTime.formatIsoDateUtc(DateTime.add(start, { days: index }));
        return (
          <CalendarDay
            key={date}
            date={date}
            items={view.occurrences.filter((item) => item.expectedDate === date)}
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
  return (
    <div
      data-recurring-slot="calendar"
      className="@container min-w-0"
      aria-label="Calendario de recurrentes"
    >
      <p className="py-3 text-xs text-muted-foreground @min-5xl:hidden">
        Recurrentes por día. Selecciona una fecha para verlos.
      </p>
      <CalendarGrid view={view} open={open} agenda={agenda} />
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
              items={view.occurrences.filter((item) => item.expectedDate === selected.value)}
              open={openItem}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
};
