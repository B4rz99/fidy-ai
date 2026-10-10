import * as React from "react";
import { cn } from "@/ui/class-names";
import { type DayButton, DayPicker, getDefaultClassNames } from "react-day-picker";

import { Button } from "./button";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon } from "@hugeicons/core-free-icons";

const Calendar = ({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = "label",
  locale,
  formatters,
  components,
  ...props
}: React.ComponentProps<typeof DayPicker>): React.JSX.Element => (
  <DayPicker
    showOutsideDays={showOutsideDays}
    className={cn(
      "group/calendar bg-background p-0 sm:p-2 [--cell-radius:var(--radius-md)] [--cell-size:--spacing(11)] in-data-[slot=card-content]:bg-transparent in-data-[slot=popover-content]:bg-transparent",
      String.raw`rtl:**:[.rdp-button\_next>svg]:rotate-180`,
      String.raw`rtl:**:[.rdp-button\_previous>svg]:rotate-180`,
      className
    )}
    captionLayout={captionLayout}
    locale={locale}
    formatters={{
      formatMonthDropdown: (date) => date.toLocaleString(locale?.code, { month: "short" }),
      ...formatters,
    }}
    classNames={{ ...calendarClassNames, ...classNames }}
    components={{
      Root: ({ className, rootRef, ...props }) => (
        <div data-slot="calendar" ref={rootRef} className={cn(className)} {...props} />
      ),
      Chevron: CalendarChevron,
      DayButton: ({ ...props }) => <CalendarDayButton locale={locale} {...props} />,
      WeekNumber: ({ children, ...props }) => (
        <td {...props}>
          <div className="flex size-(--cell-size) items-center justify-center text-center">
            {children}
          </div>
        </td>
      ),
      ...components,
    }}
    {...props}
  />
);

const CalendarDayButton = ({
  className,
  day,
  modifiers,
  locale,
  ...props
}: React.ComponentProps<typeof DayButton> & {
  locale: React.ComponentProps<typeof DayPicker>["locale"];
}): React.JSX.Element => {
  const focusDay = React.useCallback<React.RefCallback<HTMLButtonElement>>(
    (element): void => {
      if (modifiers.focused === true) {
        element?.focus();
      }
    },
    [modifiers.focused]
  );

  return (
    <Button
      ref={focusDay}
      variant="ghost"
      size="icon"
      data-day={day.date.toLocaleDateString(locale?.code)}
      data-selected-single={
        modifiers.selected === true &&
        modifiers.range_start !== true &&
        modifiers.range_end !== true &&
        modifiers.range_middle !== true
      }
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      className={cn(
        "relative isolate z-10 flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 border-0 leading-none font-normal group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:border-ring group-data-[focused=true]/day:ring-[3px] group-data-[focused=true]/day:ring-ring/50 data-[range-end=true]:rounded-(--cell-radius) data-[range-end=true]:rounded-r-(--cell-radius) data-[range-end=true]:bg-primary data-[range-end=true]:text-primary-foreground data-[range-middle=true]:rounded-none data-[range-middle=true]:bg-muted data-[range-middle=true]:text-foreground data-[range-start=true]:rounded-(--cell-radius) data-[range-start=true]:rounded-l-(--cell-radius) data-[range-start=true]:bg-primary data-[range-start=true]:text-primary-foreground data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground dark:hover:text-foreground [&>span]:text-xs [&>span]:opacity-70",
        defaultClassNames.day,
        className
      )}
      {...props}
    />
  );
};

export { Calendar, CalendarDayButton };

const defaultClassNames = getDefaultClassNames();
const calendarClassNames = {
  root: cn("w-fit", defaultClassNames.root),
  months: cn("relative flex flex-col gap-4 md:flex-row", defaultClassNames.months),
  month: cn("flex w-full flex-col gap-4", defaultClassNames.month),
  nav: cn(
    "absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1",
    defaultClassNames.nav
  ),
  button_previous: cn(
    "hover:bg-muted rounded-md",
    "size-(--cell-size) p-0 select-none aria-disabled:opacity-50",
    defaultClassNames.button_previous
  ),
  button_next: cn(
    "hover:bg-muted rounded-md",
    "size-(--cell-size) p-0 select-none aria-disabled:opacity-50",
    defaultClassNames.button_next
  ),
  month_caption: cn(
    "flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
    defaultClassNames.month_caption
  ),
  dropdowns: cn(
    "flex h-(--cell-size) w-full items-center justify-center gap-1.5 text-sm font-medium",
    defaultClassNames.dropdowns
  ),
  dropdown_root: cn("relative rounded-(--cell-radius)", defaultClassNames.dropdown_root),
  dropdown: cn("absolute inset-0 bg-popover opacity-0", defaultClassNames.dropdown),
  caption_label: cn(
    "font-medium select-none",
    "flex items-center gap-1 rounded-(--cell-radius) text-sm [&>svg]:size-3.5 [&>svg]:text-muted-foreground",
    defaultClassNames.caption_label
  ),
  month_grid: cn("w-full border-collapse", defaultClassNames.month_grid),
  weekdays: cn("flex", defaultClassNames.weekdays),
  weekday: cn(
    "flex-1 rounded-(--cell-radius) text-[0.8rem] font-normal text-muted-foreground select-none",
    defaultClassNames.weekday
  ),
  week: cn("mt-2 flex w-full", defaultClassNames.week),
  week_number_header: cn("w-(--cell-size) select-none", defaultClassNames.week_number_header),
  week_number: cn("text-[0.8rem] text-muted-foreground select-none", defaultClassNames.week_number),
  day: cn(
    "group/day relative aspect-square h-full w-full rounded-(--cell-radius) p-0 text-center select-none [&:last-child[data-selected=true]_button]:rounded-r-(--cell-radius)",
    "[&:first-child[data-selected=true]_button]:rounded-l-(--cell-radius)",
    defaultClassNames.day
  ),
  range_start: cn(
    "relative isolate z-0 rounded-l-(--cell-radius) bg-muted after:absolute after:inset-y-0 after:right-0 after:w-4 after:bg-muted",
    defaultClassNames.range_start
  ),
  range_middle: cn("rounded-none", defaultClassNames.range_middle),
  range_end: cn(
    "relative isolate z-0 rounded-r-(--cell-radius) bg-muted after:absolute after:inset-y-0 after:left-0 after:w-4 after:bg-muted",
    defaultClassNames.range_end
  ),
  today: cn(
    "rounded-(--cell-radius) bg-muted text-foreground data-[selected=true]:rounded-none",
    defaultClassNames.today
  ),
  outside: cn(
    "text-muted-foreground aria-selected:text-muted-foreground",
    defaultClassNames.outside
  ),
  disabled: cn("text-muted-foreground opacity-50", defaultClassNames.disabled),
  hidden: cn("invisible", defaultClassNames.hidden),
};

const CalendarChevron = ({
  className,
  orientation,
  ...props
}: React.ComponentProps<
  NonNullable<NonNullable<React.ComponentProps<typeof DayPicker>["components"]>["Chevron"]>
>): React.JSX.Element => {
  if (orientation === "left") {
    return (
      <HugeiconsIcon
        icon={ArrowLeftIcon}
        strokeWidth={1.5}
        className={cn("size-4", className)}
        {...props}
      />
    );
  }

  if (orientation === "right") {
    return (
      <HugeiconsIcon
        icon={ArrowRightIcon}
        strokeWidth={1.5}
        className={cn("size-4", className)}
        {...props}
      />
    );
  }

  return (
    <HugeiconsIcon
      icon={ArrowDownIcon}
      strokeWidth={1.5}
      className={cn("size-4", className)}
      {...props}
    />
  );
};
