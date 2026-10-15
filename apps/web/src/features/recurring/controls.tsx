import { type JSX } from "react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Calendar03Icon,
  FilterHorizontalIcon,
  Menu01Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/ui/components/button";
import { Summary } from "./summary";
import { type Workspace, monthLabel } from "./model";

type ToolbarProps = Readonly<{
  tab: string;
  setTab: (tab: string) => void;
  disabled: boolean;
  create: () => void;
  filtersOpen: boolean;
  toggleFilters: () => void;
  filterCount: number;
}>;
export const RecurringToolbar = ({
  tab,
  setTab,
  disabled,
  create,
  filtersOpen,
  toggleFilters,
  filterCount,
}: ToolbarProps): JSX.Element => (
  <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b px-5 py-3">
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <h1 className="text-lg font-semibold tracking-tight">Recurrentes</h1>
      <ToolbarTabs tab={tab} setTab={setTab} />
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button
        contentLayout="wrap"
        focusAppearance="subtle"
        size="sm"
        variant="outline"
        aria-expanded={filtersOpen}
        aria-controls="recurring-filters"
        onClick={toggleFilters}
      >
        <HugeiconsIcon icon={FilterHorizontalIcon} data-icon="inline-start" />
        Filtros{filterCount > 0 ? ` (${filterCount})` : ""}
      </Button>
      <Button
        contentLayout="wrap"
        focusAppearance="subtle"
        size="sm"
        variant="outline"
        aria-pressed={tab === "all"}
        onClick={() => setTab("all")}
      >
        <HugeiconsIcon icon={Settings01Icon} data-icon="inline-start" />
        Administrar
      </Button>
      <Button
        contentLayout="wrap"
        focusAppearance="subtle"
        size="sm"
        disabled={disabled}
        onClick={create}
      >
        Nuevo recurrente
      </Button>
    </div>
  </header>
);
const ToolbarTabs = ({ tab, setTab }: Pick<ToolbarProps, "tab" | "setTab">): JSX.Element => (
  <nav aria-label="Vistas de recurrentes" className="flex min-w-0 flex-wrap items-center gap-1">
    <Button
      contentLayout="wrap"
      focusAppearance="subtle"
      size="sm"
      variant={tab === "monthly" ? "secondary" : "ghost"}
      aria-pressed={tab === "monthly"}
      onClick={() => setTab("monthly")}
    >
      Mensual
    </Button>
    <Button
      contentLayout="wrap"
      focusAppearance="subtle"
      size="sm"
      variant={tab === "all" ? "secondary" : "ghost"}
      aria-pressed={tab === "all"}
      onClick={() => setTab("all")}
    >
      Todos los recurrentes
    </Button>
  </nav>
);
type MonthProps = Readonly<{
  view: Workspace;
  calendar: boolean;
  setCalendar: (value: boolean) => void;
  month: (step: number) => void;
  today: () => void;
}>;
export const MonthlyOverview = (props: MonthProps): JSX.Element => (
  <section
    aria-label="Resumen mensual"
    className="@container min-w-0 overflow-hidden rounded-xl border bg-card"
  >
    <MonthControls {...props} />
    <Summary view={props.view} />
  </section>
);
const MonthControls = ({ view, calendar, setCalendar, month, today }: MonthProps): JSX.Element => (
  <div className="flex flex-wrap items-center justify-between gap-3 px-2 py-4">
    <h2 className="text-xl font-semibold first-letter:uppercase">{monthLabel(view.month)}</h2>
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Button
          contentLayout="wrap"
          focusAppearance="subtle"
          size="icon-sm"
          variant="ghost"
          aria-label="Mes anterior"
          onClick={() => month(-1)}
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} />
        </Button>
        <Button
          contentLayout="wrap"
          focusAppearance="subtle"
          size="icon-sm"
          variant="ghost"
          aria-label="Mes siguiente"
          onClick={() => month(1)}
        >
          <HugeiconsIcon icon={ArrowRight01Icon} />
        </Button>
        <Button
          contentLayout="wrap"
          focusAppearance="subtle"
          size="sm"
          variant="outline"
          onClick={today}
        >
          Hoy
        </Button>
      </div>
      <MonthPresentation calendar={calendar} setCalendar={setCalendar} />
    </div>
  </div>
);

const MonthPresentation = ({
  calendar,
  setCalendar,
}: Pick<MonthProps, "calendar" | "setCalendar">): JSX.Element => (
  <div
    className="flex flex-wrap items-center gap-1 rounded-2xl border p-1"
    role="toolbar"
    aria-label="Presentación del mes"
  >
    <Button
      contentLayout="wrap"
      focusAppearance="subtle"
      size="sm"
      variant="view"
      aria-pressed={!calendar}
      onClick={() => setCalendar(false)}
    >
      <HugeiconsIcon icon={Menu01Icon} data-icon="inline-start" />
      Lista
    </Button>
    <Button
      contentLayout="wrap"
      focusAppearance="subtle"
      size="sm"
      variant="view"
      aria-pressed={calendar}
      onClick={() => setCalendar(true)}
    >
      <HugeiconsIcon icon={Calendar03Icon} data-icon="inline-start" />
      Calendario
    </Button>
  </div>
);
