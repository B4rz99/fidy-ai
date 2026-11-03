import { useRouterState } from "@tanstack/react-router";
import { Array, Option } from "effect";
import { type Dispatch, type JSX, type ReactNode, type SetStateAction, useState } from "react";
import { Button } from "@/ui/components/button";
import {
  RecurringColumns,
  RecurringContextPanel,
  RecurringSurface,
  RecurringThemeControl,
} from "@/ui/components/recurring";
import { useTheme } from "@/ui/components/theme";
import { MonthlyOverview, RecurringToolbar } from "./controls";
import { OccurrenceDetails } from "./details";
import { PlanLifecycle } from "./lifecycle";
import { FiltersForm } from "./filters";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { MonthCalendar } from "./month";
import { OccurrenceList } from "./occurrence-list";
import { TransactionLink } from "./transaction-link";
import { CreatePlan, type CreationReceipt } from "./create-plan";
import { CreationResult } from "./creation-result";
import { PlanForm } from "./plan-form";
import { PlanManagement, Suggestions } from "./management";
import {
  type Category,
  type Filters,
  type Occurrence,
  type Plan,
  type PlanInput,
  type Save,
  type Workspace,
  type WorkspaceReadState,
  type planStatus,
} from "./model";

type Panel =
  | Readonly<{
      kind: "create";
      initial: Partial<PlanInput> & Pick<PlanInput, "timeZone">;
      seriesId: Option.Option<string>;
    }>
  | Readonly<{ kind: "occurrence" | "link"; planId: Occurrence["planId"]; date: string }>
  | (CreationReceipt & Readonly<{ kind: "created" }>)
  | Readonly<{ kind: "plan"; planId: Occurrence["planId"] }>;
type Props = Readonly<{
  calendar: boolean;
  setCalendar: (value: boolean) => void;
  notice: ReactNode;
  tab: string;
  setTab: (tab: string) => void;
  readState: WorkspaceReadState;
  view: Workspace;
  categories: ReadonlyArray<Category>;
  save: Save;
  statusFor: typeof planStatus;
  disabled: boolean;
  filters: Filters;
  applyFilters: (filters: Filters) => void;
  month: (step: number) => void;
  earlier: (month: string) => void;
  timeZone: PlanInput["timeZone"];
}>;
const selectedOccurrence = (
  view: Workspace,
  panel: Extract<Panel, { kind: "occurrence" | "link" }>
): Option.Option<Occurrence> =>
  Array.findFirst(
    [...view.occurrences, ...view.previous],
    (item) => item.planId === panel.planId && item.date === panel.date
  );
const linkSelection = (panel: Option.Option<Panel>): Option.Option<Panel> =>
  Option.map(panel, (value) => (value.kind === "occurrence" ? { ...value, kind: "link" } : value));
type EditorProps = Pick<Props, "view" | "categories" | "disabled" | "save" | "statusFor">;
type SheetProps = EditorProps &
  Pick<Props, "notice"> &
  Readonly<{
    panel: Option.Option<Panel>;
    setPanel: Dispatch<SetStateAction<Option.Option<Panel>>>;
    link: () => void;
  }>;
const Editor = ({
  panel,
  view,
  categories,
  disabled,
  save,
  statusFor,
  link,
  created,
  close,
}: EditorProps &
  Readonly<{
    panel: Panel;
    link: () => void;
    created: (receipt: CreationReceipt) => void;
    close: () => void;
  }>): JSX.Element => {
  if (panel.kind === "occurrence") {
    return (
      <OccurrenceEditor panel={panel} {...{ view, categories, disabled, save, statusFor, link }} />
    );
  }
  if (panel.kind === "create") {
    return (
      <CreatePlan
        {...panel}
        categories={categories}
        disabled={disabled}
        save={save}
        created={created}
      />
    );
  }
  if (panel.kind === "created") {
    return (
      <CreationResult
        receipt={panel}
        minimumRevision={view.document.revision}
        categories={categories}
        disabled={disabled}
        save={save}
        close={close}
      />
    );
  }
  return <PlanEditor planId={panel.planId} {...{ view, categories, disabled, save, statusFor }} />;
};
const OccurrenceEditor = ({
  panel,
  view,
  categories,
  disabled,
  save,
  statusFor,
  link,
}: EditorProps &
  Readonly<{
    panel: Extract<Panel, { kind: "occurrence" | "link" }>;
    link: () => void;
  }>): JSX.Element => {
  const invalidIds = new Set(view.invalidFulfillmentIds);
  const item = selectedOccurrence(view, panel);
  const plan = view.document.plans.find((entry) => entry.id === panel.planId);
  const lifecycle =
    plan === undefined ? null : (
      <PlanLifecycle
        plan={plan}
        status={statusFor(plan)}
        save={save}
        disabled={disabled}
        today={view.today}
      />
    );
  if (Option.isNone(item)) {
    return (
      <div className="grid gap-5">
        {lifecycle}
        <p>Esta fecha ya no aparece en la vista actual. Los registros existentes se conservan.</p>
      </div>
    );
  }
  return (
    <div className="grid gap-5">
      {lifecycle}
      <OccurrenceDetails
        item={item.value}
        document={view.document}
        transactions={view.linkedTransactions}
        invalidMarks={view.document.fulfillments.filter(
          (mark) =>
            mark.planId === panel.planId && mark.date === panel.date && invalidIds.has(mark.id)
        )}
        categories={categories}
        disabled={disabled}
        save={save}
        today={view.today}
        link={link}
      />
    </div>
  );
};
const PlanEditor = ({
  planId,
  view,
  categories,
  disabled,
  save,
  statusFor,
}: EditorProps & Readonly<{ planId: Plan["id"] }>): JSX.Element => {
  const plan = view.document.plans.find((entry) => entry.id === planId);
  const latest = plan?.revisions.at(-1);
  return plan === undefined || latest === undefined ? (
    <p>Plan no disponible.</p>
  ) : (
    <div className="grid gap-5">
      <PlanLifecycle
        plan={plan}
        status={statusFor(plan)}
        save={save}
        disabled={disabled}
        today={view.today}
      />
      <PlanForm
        key={JSON.stringify(latest.plan)}
        initial={latest.plan}
        categories={categories}
        disabled={disabled}
        onSubmit={(input) =>
          save({ kind: "edit", planId, date: view.today, scope: "forward", plan: input })
        }
      />
    </div>
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
  const { view, disabled, filters, timeZone, calendar, setCalendar, tab, setTab } = props;
  const [filtersOpen, setFiltersOpen] = useState(Object.keys(filters).length > 0);
  const [panel, setPanel] = useState<Option.Option<Panel>>(() => Option.none());
  const save: Save = (edit, onSaved) =>
    props.save(edit, () => {
      if (onSaved !== undefined) onSaved();
      else if (edit.kind !== "lifecycle" || edit.action === "stop") {
        setPanel((current) => (current === panel ? Option.none() : current));
      }
    });
  const editing = { ...props, save };
  const open = (item: Occurrence): void =>
    setPanel(Option.some({ kind: "occurrence", planId: item.planId, date: item.date }));
  const link = (): void => setPanel(linkSelection(panel));
  const create = (): void =>
    setPanel(
      Option.some({
        kind: "create",
        initial: { firstDate: view.today, timeZone },
        seriesId: Option.none(),
      })
    );
  if (Option.isSome(panel) && panel.value.kind === "link") {
    const selection = panel.value;
    const close = (): void => setPanel(Option.some({ ...selection, kind: "occurrence" }));
    return <LinkWorkspace {...editing} selection={selection} close={close} />;
  }
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
        panel={<EditorSheet {...editing} panel={panel} setPanel={setPanel} link={link} />}
      >
        <WorkspaceBody
          props={editing}
          create={create}
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

const LinkWorkspace = ({
  selection,
  close,
  ...props
}: Props &
  Readonly<{
    selection: Extract<Panel, { kind: "occurrence" | "link" }>;
    close: () => void;
  }>): JSX.Element => {
  const item = selectedOccurrence(props.view, selection);
  return Option.isSome(item) ? (
    <TransactionLink
      key={`${item.value.planId}:${item.value.date}`}
      item={item.value}
        document={view.document}
      disabled={props.disabled}
      save={props.save}
      notice={props.notice}
      close={close}
    />
  ) : (
    <main className="grid gap-4 p-5">
      <p>La ocurrencia ya no está en esta vista.</p>
      <Button variant="outline" onClick={close}>
        Volver
      </Button>
      {props.notice}
    </main>
  );
};

type WorkspaceBodyProps = Readonly<{
  props: Props;
  create: () => void;
  tab: string;
  calendar: boolean;
  setCalendar: (value: boolean) => void;
  filtersOpen: boolean;
  setPanel: Dispatch<SetStateAction<Option.Option<Panel>>>;
  open: (item: Occurrence) => void;
}>;
const WorkspaceBody = ({
  props,
  create,
  tab,
  calendar,
  setCalendar,
  filtersOpen,
  setPanel,
  open,
}: WorkspaceBodyProps): JSX.Element => {
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
          readState={props.readState}
          create={create}
          applyFilters={props.applyFilters}
          filters={filters}
          open={(plan) => setPanel(Option.some({ kind: "plan", planId: plan.id }))}
          disabled={disabled}
          save={save}
          statusFor={props.statusFor}
        />
      )}
    </main>
  );
};

const editorTitle = (panel: Option.Option<Panel>, view: Workspace): string =>
  Option.match(panel, {
    onNone: () => "Configurar recurrente",
    onSome: (selected) => {
      if (selected.kind === "occurrence") {
        return selectedOccurrence(view, selected).pipe(
          Option.map((item) => item.plan.name),
          Option.getOrElse(
            () =>
              view.document.plans.find((plan) => plan.id === selected.planId)?.revisions.at(-1)
                ?.plan.name ?? "Recurrente no disponible"
          )
        );
      }
      if (selected.kind === "create") {
        return "Nuevo recurrente";
      }
      if (selected.kind === "created") {
        return "Recurrente guardado";
      }
      return "Editar recurrente";
    },
  });
const EditorSheet = ({
  notice,
  panel,
  setPanel,
  view,
  categories,
  disabled,
  save,
  statusFor,
  link,
}: SheetProps): JSX.Element => {
  const { theme, toggle } = useTheme();
  const active = useRouterState({
    select: (state) => state.location.pathname === "/app/recurring",
  });

  return (
    <RecurringContextPanel
      title={editorTitle(panel, view)}
      themeControl={<RecurringThemeControl theme={theme} toggle={toggle} />}
      open={active && Option.isSome(panel)}
      onClose={() => setPanel(Option.none())}
    >
      {notice}
      {Option.isSome(panel) ? (
        <Editor
          key={JSON.stringify(panel.value)}
          panel={panel.value}
          link={link}
          created={(receipt) =>
            setPanel((current) =>
              current === panel ? Option.some({ kind: "created", ...receipt }) : current
            )
          }
          close={() => setPanel(Option.none())}
          view={view}
          categories={categories}
          disabled={disabled}
          save={save}
          statusFor={statusFor}
        />
      ) : null}
      {Option.isSome(panel) &&
      panel.value.kind !== "occurrence" &&
      panel.value.kind !== "created" ? (
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
      <>
        {calendar ? <MonthCalendar key={view.month} view={view} open={open} /> : null}
        <EmptyMonth filters={filters} applyFilters={applyFilters} />
      </>
    );
  }
  return calendar ? (
    <MonthCalendar key={view.month} view={view} open={open} />
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

const EmptyMonth = ({
  filters,
  applyFilters,
}: Readonly<{ filters: Filters; applyFilters: (filters: Filters) => void }>): JSX.Element => (
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
