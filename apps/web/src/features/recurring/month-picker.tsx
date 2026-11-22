import { type JSX, useState } from "react";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/ui/components/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/ui/components/popover";
import { monthLabel, shortMonthLabel } from "./model";

const yearOf = (month: string): number => Number(month.slice(0, "2026".length));

const monthNumbers = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

type YearProps = Readonly<{ year: number; setYear: (year: number) => void }>;

const YearStepper = ({ year, setYear }: YearProps): JSX.Element => (
  <div className="flex items-center justify-between">
    <Button
      contentLayout="wrap"
      focusAppearance="subtle"
      size="icon-sm"
      variant="ghost"
      aria-label="Año anterior"
      onClick={() => setYear(year - 1)}
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} />
    </Button>
    <span className="text-sm font-semibold" aria-live="polite">
      {year}
    </span>
    <Button
      contentLayout="wrap"
      focusAppearance="subtle"
      size="icon-sm"
      variant="ghost"
      aria-label="Año siguiente"
      onClick={() => setYear(year + 1)}
    >
      <HugeiconsIcon icon={ArrowRight01Icon} />
    </Button>
  </div>
);

type GridProps = Readonly<{
  year: number;
  month: string;
  today: string;
  choose: (month: string) => void;
}>;

const MonthGrid = ({ year, month, today, choose }: GridProps): JSX.Element => (
  <div className="grid grid-cols-3 gap-1">
    {monthNumbers.map((number) => {
      const value = `${year}-${number}`;

      return (
        <Button
          key={value}
          contentLayout="wrap"
          focusAppearance="subtle"
          size="sm"
          variant="view"
          data-recurring-slot="month-choice"
          aria-label={monthLabel(value)}
          aria-pressed={value === month}
          aria-current={today.startsWith(value) ? "date" : undefined}
          onClick={() => choose(value)}
        >
          {shortMonthLabel(value)}
        </Button>
      );
    })}
  </div>
);

type MonthPickerProps = Readonly<{
  month: string;
  today: string;
  select: (month: string) => void;
}>;

export const MonthPicker = ({ month, today, select }: MonthPickerProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => yearOf(month));

  const choose = (value: string): void => {
    setOpen(false);
    select(value);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setYear(yearOf(month));
      }}
    >
      <PopoverTrigger
        render={
          <Button
            contentLayout="wrap"
            focusAppearance="subtle"
            variant="ghost"
            data-recurring-slot="month-picker"
            aria-label={`Elegir mes, ${monthLabel(month)}`}
          />
        }
      >
        <span>{monthLabel(month)}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-3 p-3">
        <PopoverTitle className="sr-only">Elegir mes</PopoverTitle>
        <YearStepper year={year} setYear={setYear} />
        <MonthGrid {...{ year, month, today, choose }} />
      </PopoverContent>
    </Popover>
  );
};
