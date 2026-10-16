import { browserCrypto } from "@/browser/crypto";
import { Array, Effect, Option } from "effect";
import { type JSX, type ReactNode, useState } from "react";
import { RecurringPlanId } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { Disclosure } from "@/ui/components/disclosure";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/ui/components/sheet";
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
  today: () => void;
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
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
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
  <details className="group/previous min-w-0 rounded-xl border bg-card px-2 py-3">
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
    <>
      <RecurringToolbar
        create={create}
        disabled={disabled}
        tab={tab}
        setTab={setTab}
        filtersOpen={filtersOpen}
        toggleFilters={() => setFiltersOpen(!filtersOpen)}
        filterCount={Object.keys(filters).length}
      />
      <WorkspaceBody
        props={props}
        tab={tab}
        calendar={calendar}
        setCalendar={setCalendar}
        filtersOpen={filtersOpen}
        setPanel={setPanel}
        open={open}
      />
      <EditorSheet {...props} panel={panel} setPanel={setPanel} />
    </>
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
    <main className="grid gap-4 p-4 sm:p-5">
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
          today={props.today}
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
  }>): JSX.Element => (
  <>
    <Sheet
      open={Option.isSome(panel)}
      onOpenChange={(opened) => {
        if (!opened) setPanel(Option.none());
      }}
    >
      <SheetContent
        side="right"
        showCloseButton
        appearance="application"
        className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
      >
        <SheetHeader>
          <SheetTitle>
            {Option.isSome(panel) && panel.value.kind === "occurrence"
              ? selectedOccurrence(view, panel.value).pipe(
                  Option.map((item) => item.plan.name),
                  Option.getOrElse(() => "Recurrente no disponible")
                )
              : "Configurar recurrente"}
          </SheetTitle>
        </SheetHeader>
        {notice}
        {Option.isSome(panel) ? (
          <Editor
            panel={panel.value}
            view={view}
            categories={categories}
            disabled={disabled}
            save={save}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  </>
);

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
      <div className="min-w-0 rounded-xl border border-dashed p-4 text-center [overflow-wrap:anywhere]">
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
      <div className="p-5">
        <Disclosure title="Crear desde una transacción">
          <TransactionPicker
            disabled={disabled}
            choose={(transaction) =>
              setInitial(planFromTransaction({ transaction, timeZone: panel.initial.timeZone }))
            }
          />
        </Disclosure>
      </div>
      <PlanForm
        key={JSON.stringify(initial)}
        initial={initial}
        categories={categories}
        disabled={disabled}
        onSubmit={(plan) =>
          save({
            kind: "create",
            id: RecurringPlanId.make(Effect.runSync(browserCrypto.randomUUIDv4.pipe(Effect.orDie))),
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
          variant="outline"
          disabled={disabled}
          onClick={() => save({ kind: "reverse", fulfillmentId: id })}
        >
          Retirar vínculo anterior
        </Button>
      </div>
    ))}
  </>
);
