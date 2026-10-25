import { type JSX } from "react";
import {
  Add01Icon,
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
  <header data-recurring-slot="page-header">
    <div data-recurring-slot="title-tabs">
      <h1 className="text-lg font-semibold tracking-tight">Recurrentes</h1>
      <ToolbarTabs tab={tab} setTab={setTab} />
    </div>
    <div data-recurring-slot="header-actions">
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
        <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" />
        Nuevo recurrente
      </Button>
    </div>
  </header>
);
const ToolbarTabs = ({ tab, setTab }: Pick<ToolbarProps, "tab" | "setTab">): JSX.Element => (
  <nav aria-label="Vistas de recurrentes" data-recurring-slot="tabs">
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
}>;
export const MonthlyOverview = (props: MonthProps): JSX.Element => (
  <section
    aria-label="Resumen mensual"
    data-recurring-slot="monthly-overview"
    className="@container min-w-0"
  >
    <MonthControls {...props} />
    <Summary view={props.view} />
  </section>
);
const MonthControls = ({ view, calendar, setCalendar, month }: MonthProps): JSX.Element => (
  <div data-recurring-slot="month-controls">
    <h2>{monthLabel(view.month)}</h2>
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
      </div>
      <MonthPresentation calendar={calendar} setCalendar={setCalendar} />
    </div>
  </div>
);

const MonthPresentation = ({
  calendar,
  setCalendar,
}: Pick<MonthProps, "calendar" | "setCalendar">): JSX.Element => (
  <div data-recurring-slot="presentation-toggle" role="toolbar" aria-label="Presentación del mes">
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
