import { useRouterState } from "@tanstack/react-router";
import { browserCrypto } from "@/browser/crypto";
import { Array, Effect, Option } from "effect";
import { type JSX, type ReactNode, useState } from "react";
import { RecurringPlanId } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { DeferredDisclosure } from "@/ui/components/disclosure";
import {
  RecurringColumns,
  RecurringContextPanel,
  RecurringSurface,
  RecurringThemeControl,
} from "@/ui/components/recurring";
import { useTheme } from "@/ui/components/theme";
import { MonthlyOverview, RecurringToolbar } from "./controls";
import { OccurrenceDetails } from "./details";
import { FiltersForm } from "./filters";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { MonthCalendar } from "./month";
import { OccurrenceList } from "./occurrence-list";
import { TransactionPicker } from "./transactions";
import { PlanForm } from "./plan-form";
import { PlanManagement, Suggestions } from "./management";
import {
  type Category,
  type Filters,
  type Occurrence,
  type PlanInput,
  type Save,
  type Workspace,
  planFromTransaction,
} from "./model";

type Panel =
  | Readonly<{
      kind: "create";
      initial: Partial<PlanInput> & Pick<PlanInput, "timeZone">;
      seriesId: Option.Option<string>;
    }>
  | Readonly<{ kind: "occurrence"; planId: Occurrence["planId"]; date: string }>
  | Readonly<{ kind: "plan"; planId: Occurrence["planId"] }>;
type Props = Readonly<{
  notice: ReactNode;
  view: Workspace;
  categories: ReadonlyArray<Category>;
  save: Save;
  disabled: boolean;
  filters: Filters;
  applyFilters: (filters: Filters) => void;
  month: (step: number) => void;
  earlier: (month: string) => void;
  timeZone: PlanInput["timeZone"];
}>;
const selectedOccurrence = (
  view: Workspace,
  panel: Extract<Panel, { kind: "occurrence" }>
): Option.Option<Occurrence> =>
  Array.findFirst(
    [...view.occurrences, ...view.previous],
    (item) => item.planId === panel.planId && item.date === panel.date
  );
const Editor = ({
  panel,
  view,
  categories,
  disabled,
  save,
}: Readonly<{
  panel: Panel;
  view: Workspace;
  categories: ReadonlyArray<Category>;
  disabled: boolean;
  save: Save;
}>): JSX.Element => {
  if (panel.kind === "occurrence") {
    const item = selectedOccurrence(view, panel);
    if (Option.isNone(item)) {
      return (
        <p>Este elemento ya no está en la vista actual. Cierra el detalle y revisa los filtros.</p>
      );
    }
    return (
      <OccurrenceDetails
        item={item.value}
        categories={categories}
        disabled={disabled}
        save={save}
        today={view.today}
      />
    );
  }
  if (panel.kind === "create") {
    return <CreatePlan panel={panel} categories={categories} disabled={disabled} save={save} />;
  }
  const latest = view.document.plans.find((plan) => plan.id === panel.planId)?.revisions.at(-1);
  return latest === undefined ? (
    <p>Plan no disponible.</p>
  ) : (
    <PlanForm
      initial={latest.plan}
      categories={categories}
      disabled={disabled}
      onSubmit={(plan) =>
        save({ kind: "edit", planId: panel.planId, date: view.today, scope: "forward", plan })
      }
    />
  );
};
const Matching = ({ view }: Pick<Props, "view">): JSX.Element => (
  <>
    {view.matchesComplete ? null : (
      <output className="text-sm text-muted-foreground">
        La búsqueda de coincidencias está incompleta. Revisa tus transacciones manualmente.
      </output>
    )}
    {view.matches.map(({ item, fact }) => (
      <div
        key={`${item.planId}:${item.date}`}
        data-recurring-slot="match"
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <p className="text-sm">
          Coincidencia exacta: {item.plan.name} · {fact.date}
        </p>
        <span className="text-xs text-muted-foreground">Vinculada automáticamente</span>
      </div>
    ))}
  </>
);
const Monthly = ({
  filters,
  applyFilters,
  view,
  calendar,
  open,
  earlier,
  categories,
  save,
  disabled,
}: Pick<
  Props,
  "view" | "save" | "disabled" | "earlier" | "categories" | "filters" | "applyFilters"
> &
  Readonly<{ calendar: boolean; open: (item: Occurrence) => void }>): JSX.Element => (
  <>
    <Matching view={view} />
    <MonthItems
      filters={filters}
      applyFilters={applyFilters}
      view={view}
      calendar={calendar}
      open={open}
      categories={categories}
      save={save}
      disabled={disabled}
    />
    <PreviousItems
      view={view}
      earlier={earlier}
      open={open}
      categories={categories}
      save={save}
      disabled={disabled}
    />
  </>
);
const PreviousItems = ({
  view,
  earlier,
  open,
  categories,
  save,
  disabled,
}: Pick<Props, "view" | "earlier" | "categories" | "save" | "disabled"> &
  Readonly<{ open: (item: Occurrence) => void }>): JSX.Element => (
  <details data-recurring-slot="previous" className="group/previous min-w-0">
    <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
      <HugeiconsIcon
        icon={ArrowDown01Icon}
        className="size-4 -rotate-90 transition-transform group-open/previous:rotate-0"
      />
      Pendientes de meses anteriores{view.previous.length > 0 ? ` · ${view.previous.length}` : ""}
    </summary>
    <div className="mt-3 grid min-w-0 gap-3">
      <p className="text-xs text-muted-foreground">
        Conservan los totales de su mes original. La ausencia de una transacción no significa que
        estén vencidos.
      </p>
      {view.previous.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sin pendientes en el mes anterior consultado.
        </p>
      ) : (
        <OccurrenceList
          save={save}
          disabled={disabled}
          items={view.previous}
          open={open}
          categories={categories}
          today={view.today}
        />
      )}
      {view.previousMonth === undefined ? null : (
        <Button
          contentLayout="wrap"
          focusAppearance="subtle"
          variant="outline"
          onClick={() => {
            if (view.previousMonth !== undefined) earlier(view.previousMonth);
          }}
        >
          Consultar meses anteriores
        </Button>
      )}
    </div>
  </details>
);
export const RecurringWorkspace = (props: Props): JSX.Element => {
  const { view, disabled, filters, timeZone } = props;
  const [tab, setTab] = useState("monthly");
  const [calendar, setCalendar] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(Object.keys(filters).length > 0);
  const [panel, setPanel] = useState<Option.Option<Panel>>(() => Option.none());
  const open = (item: Occurrence): void =>
    setPanel(Option.some({ kind: "occurrence", planId: item.planId, date: item.date }));
  const create = (): void =>
    setPanel(
      Option.some({
        kind: "create",
        initial: { firstDate: view.today, timeZone },
        seriesId: Option.none(),
      })
    );
  return (
    <RecurringSurface>
      <RecurringToolbar
        create={create}
        disabled={disabled}
        tab={tab}
        setTab={setTab}
        filtersOpen={filtersOpen}
        toggleFilters={() => setFiltersOpen(!filtersOpen)}
        filterCount={Object.keys(filters).length}
      />
      {Option.isNone(panel) ? props.notice : null}
      <RecurringColumns
        open={Option.isSome(panel)}
        panel={<EditorSheet {...props} panel={panel} setPanel={setPanel} />}
      >
        <WorkspaceBody
          props={props}
          tab={tab}
          calendar={calendar}
          setCalendar={setCalendar}
          filtersOpen={filtersOpen}
          setPanel={setPanel}
          open={open}
        />
      </RecurringColumns>
    </RecurringSurface>
  );
};

const WorkspaceBody = ({
  props,
  tab,
  calendar,
  setCalendar,
  filtersOpen,
  setPanel,
  open,
}: Readonly<{
  props: Props;
  tab: string;
  calendar: boolean;
  setCalendar: (value: boolean) => void;
  filtersOpen: boolean;
  setPanel: (panel: Option.Option<Panel>) => void;
  open: (item: Occurrence) => void;
}>): JSX.Element => {
  const { view, disabled, save, filters, timeZone } = props;
  return (
    <main data-recurring-slot="content">
      <WorkspaceSuggestions
        view={view}
        save={save}
        disabled={disabled}
        timeZone={timeZone}
        setPanel={setPanel}
      />
      {filtersOpen ? (
        <FiltersForm
          key={JSON.stringify(filters)}
          filters={filters}
          categories={props.categories}
          apply={props.applyFilters}
        />
      ) : null}
      {tab === "monthly" ? (
        <MonthlyOverview
          view={view}
          calendar={calendar}
          setCalendar={setCalendar}
          month={props.month}
        />
      ) : null}
      <InvalidFulfillments view={view} save={save} disabled={disabled} />
      {tab === "monthly" ? (
        <Monthly {...props} calendar={calendar} open={open} />
      ) : (
        <PlanManagement
          view={view}
          filters={filters}
          open={(plan) => setPanel(Option.some({ kind: "plan", planId: plan.id }))}
          disabled={disabled}
          save={save}
        />
      )}
    </main>
  );
};

const EditorSheet = ({
  notice,
  panel,
  setPanel,
  view,
  categories,
  disabled,
  save,
}: Pick<Props, "view" | "categories" | "disabled" | "save" | "notice"> &
  Readonly<{
    panel: Option.Option<Panel>;
    setPanel: (panel: Option.Option<Panel>) => void;
  }>): JSX.Element => {
  const { theme, toggle } = useTheme();
  const active = useRouterState({
    select: (state) => state.location.pathname === "/app/recurring",
  });
  const title = Option.match(panel, {
    onNone: () => "Configurar recurrente",
    onSome: (selected) => {
      if (selected.kind === "occurrence") {
        return selectedOccurrence(view, selected).pipe(
          Option.map((item) => item.plan.name),
          Option.getOrElse(() => "Recurrente no disponible")
        );
      }
      return selected.kind === "create" ? "Nuevo recurrente" : "Editar recurrente";
    },
  });
  return (
    <RecurringContextPanel
      title={title}
      themeControl={<RecurringThemeControl theme={theme} toggle={toggle} />}
      open={active && Option.isSome(panel)}
      onClose={() => setPanel(Option.none())}
    >
      {notice}
      {Option.isSome(panel) ? (
        <Editor
          key={JSON.stringify(panel.value)}
          panel={panel.value}
          view={view}
          categories={categories}
          disabled={disabled}
          save={save}
        />
      ) : null}
      {Option.isSome(panel) && panel.value.kind !== "occurrence" ? (
        <Button variant="ghost" onClick={() => setPanel(Option.none())}>
          Cancelar
        </Button>
      ) : null}
    </RecurringContextPanel>
  );
};

const MonthItems = ({
  filters,
  applyFilters,
  save,
  disabled,
  view,
  calendar,
  open,
  categories,
}: Readonly<{
  categories: ReadonlyArray<Category>;
  save: Save;
  disabled: boolean;
  view: Workspace;
  calendar: boolean;
  open: (item: Occurrence) => void;
  filters: Filters;
  applyFilters: (filters: Filters) => void;
}>): JSX.Element => {
  if (view.occurrences.length === 0) {
    return (
      <div data-recurring-slot="empty" className="min-w-0 [overflow-wrap:anywhere]">
        <h2 className="font-medium">
          {Object.keys(filters).length > 0
            ? "Sin resultados para estos filtros"
            : "Sin recurrentes para este mes"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {Object.keys(filters).length > 0
            ? "Prueba otros filtros o límpialos para ver los recurrentes del mes."
            : "Crea un recurrente, revisa los patrones detectados o consulta otro mes."}
        </p>
        {Object.keys(filters).length > 0 ? (
          <Button
            contentLayout="wrap"
            focusAppearance="subtle"
            variant="outline"
            onClick={() => applyFilters({})}
          >
            Limpiar filtros
          </Button>
        ) : null}
      </div>
    );
  }
  return calendar ? (
    <MonthCalendar view={view} open={open} />
  ) : (
    <OccurrenceList
      save={save}
      disabled={disabled}
      items={view.occurrences}
      open={open}
      categories={categories}
      today={view.today}
    />
  );
};

const WorkspaceSuggestions = ({
  view,
  save,
  disabled,
  timeZone,
  setPanel,
}: Pick<Props, "view" | "save" | "disabled" | "timeZone"> &
  Readonly<{ setPanel: (panel: Option.Option<Panel>) => void }>): JSX.Element => {
  const [cursor, setCursor] = useState<Option.Option<string>>(() => Option.none());
  return (
    <>
      <Suggestions
        key={Option.getOrElse(cursor, () => "first")}
        view={view}
        save={save}
        disabled={disabled}
        timeZone={timeZone}
        cursor={cursor}
        next={(next) => setCursor(Option.some(next))}
        create={(initial, seriesId) =>
          setPanel(Option.some({ kind: "create", initial, seriesId: Option.some(seriesId) }))
        }
      />
    </>
  );
};

const CreatePlan = ({
  panel,
  categories,
  disabled,
  save,
}: Readonly<{
  panel: Extract<Panel, { kind: "create" }>;
  categories: ReadonlyArray<Category>;
  disabled: boolean;
  save: Save;
}>): JSX.Element => {
  const [initial, setInitial] = useState(panel.initial);
  return (
    <>
      <div data-recurring-slot="create-source">
        <DeferredDisclosure title="Crear desde una transacción">
          <TransactionPicker
            disabled={disabled}
            choose={(transaction) =>
              setInitial(planFromTransaction({ transaction, timeZone: panel.initial.timeZone }))
            }
          />
        </DeferredDisclosure>
      </div>
      <PlanForm
        key={JSON.stringify(initial)}
        initial={initial}
        categories={categories}
        disabled={disabled}
        onSubmit={(plan) =>
          save({
            kind: "create",
            id: RecurringPlanId.make(
              Effect.runSync(browserCrypto.randomUUIDv4().pipe(Effect.orDie))
            ),
            plan,
            ...(Option.isSome(panel.seriesId) ? { seriesId: panel.seriesId.value } : {}),
          })
        }
      />
    </>
  );
};

const InvalidFulfillments = ({
  view,
  save,
  disabled,
}: Pick<Props, "view" | "save" | "disabled">): JSX.Element => (
  <>
    {view.invalidFulfillmentIds.map((id) => (
      <div key={id} role="alert" className="flex flex-wrap items-center gap-3">
        <p>
          Este registro requiere revisión porque cambió su transacción. No se incluye como
          completado.
        </p>
        <Button
          contentLayout="wrap"
          focusAppearance="subtle"
          variant="destructive"
          disabled={disabled}
          onClick={() => save({ kind: "reverse", fulfillmentId: id })}
        >
          Retirar vínculo anterior
        </Button>
      </div>
    ))}
  </>
);
