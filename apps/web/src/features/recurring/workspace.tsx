import { browserCrypto } from "@/browser/crypto";
import { Array, Effect, Option } from "effect";
import { type JSX, type ReactNode, useState } from "react";
import { RecurringPlanId } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/ui/components/sheet";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";
import { FiltersForm } from "./filters";
import { OccurrenceDetails } from "./details";
import { MonthCalendar, OccurrenceList, Summary } from "./month";
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
  monthLabel,
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
  view,
  calendar,
  open,
  earlier,
  categories,
}: Pick<Props, "view" | "save" | "disabled" | "earlier" | "categories"> &
  Readonly<{ calendar: boolean; open: (item: Occurrence) => void }>): JSX.Element => (
  <>
    <Summary view={view} />
    <Matching view={view} />
    <MonthItems view={view} calendar={calendar} open={open} categories={categories} />
    <section className="grid gap-3">
      <h2 className="font-medium">Pendientes de meses anteriores</h2>
      <p className="text-xs text-muted-foreground">
        Conservan los totales de su mes original. La ausencia de una transacción no significa que
        estén vencidos.
      </p>
      {view.previous.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sin pendientes en el mes anterior consultado.
        </p>
      ) : (
        <OccurrenceList items={view.previous} open={open} categories={categories} />
      )}
      {view.previousMonth === undefined ? null : (
        <Button
          variant="outline"
          onClick={() => {
            if (view.previousMonth !== undefined) earlier(view.previousMonth);
          }}
        >
          Consultar meses anteriores
        </Button>
      )}
    </section>
  </>
);
export const RecurringWorkspace = (props: Props): JSX.Element => {
  const { view, categories, disabled, save, filters, applyFilters, timeZone } = props;
  const [tab, setTab] = useState("monthly");
  const [calendar, setCalendar] = useState(false);
  const [panel, setPanel] = useState<Option.Option<Panel>>(Option.none());
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
      <RecurringHeader disabled={disabled} create={create} />
      <div className="grid gap-5 p-4 sm:p-5">
        <WorkspaceTabs tab={tab} setTab={setTab} />
        <FiltersForm filters={filters} categories={categories} apply={applyFilters} />
        <MonthControls
          view={view}
          calendar={calendar}
          setCalendar={setCalendar}
          month={props.month}
          today={props.today}
        />
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
        <WorkspaceSuggestions
          view={view}
          save={save}
          disabled={disabled}
          timeZone={timeZone}
          setPanel={setPanel}
        />
      </div>
      <EditorSheet
        notice={props.notice}
        panel={panel}
        setPanel={setPanel}
        view={view}
        categories={categories}
        disabled={disabled}
        save={save}
      />
    </>
  );
};

const MonthControls = ({
  view,
  calendar,
  setCalendar,
  month,
  today,
}: Pick<Props, "view" | "month" | "today"> &
  Readonly<{ calendar: boolean; setCalendar: (value: boolean) => void }>): JSX.Element => (
  <>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-xl font-semibold capitalize">{monthLabel(view.month)}</h2>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" aria-label="Mes anterior" onClick={() => month(-1)}>
          ←
        </Button>
        <Button variant="outline" aria-label="Mes siguiente" onClick={() => month(1)}>
          →
        </Button>
        <Button variant="outline" onClick={today}>
          Hoy
        </Button>
        <Button
          variant={calendar ? "ghost" : "secondary"}
          aria-pressed={!calendar}
          onClick={() => setCalendar(false)}
        >
          Lista
        </Button>
        <Button
          variant={calendar ? "secondary" : "ghost"}
          aria-pressed={calendar}
          onClick={() => setCalendar(true)}
        >
          Calendario
        </Button>
      </div>
    </div>
  </>
);

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
  view,
  calendar,
  open,
  categories,
}: Readonly<{
  categories: ReadonlyArray<Category>;
  view: Workspace;
  calendar: boolean;
  open: (item: Occurrence) => void;
}>): JSX.Element => {
  if (view.occurrences.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center">
        <h2 className="font-medium">Sin recurrentes para este mes</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Crea tu primer recurrente o revisa los patrones detectados.
        </p>
      </div>
    );
  }
  return calendar ? (
    <MonthCalendar view={view} open={open} categories={categories} />
  ) : (
    <OccurrenceList items={view.occurrences} open={open} categories={categories} />
  );
};

const RecurringHeader = ({
  disabled,
  create,
}: Readonly<{ disabled: boolean; create: () => void }>): JSX.Element => (
  <>
    <WorkspaceHeader
      title="Recurrentes"
      context={
        <p className="text-sm text-muted-foreground">
          Tus próximos ingresos, gastos y transferencias
        </p>
      }
    >
      <Button disabled={disabled} onClick={create}>
        Nuevo recurrente
      </Button>
    </WorkspaceHeader>
  </>
);

const WorkspaceSuggestions = ({
  view,
  save,
  disabled,
  timeZone,
  setPanel,
}: Pick<Props, "view" | "save" | "disabled" | "timeZone"> &
  Readonly<{ setPanel: (panel: Option.Option<Panel>) => void }>): JSX.Element => {
  const [cursor, setCursor] = useState<Option.Option<string>>(Option.none());
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

const WorkspaceTabs = ({
  tab,
  setTab,
}: Readonly<{ tab: string; setTab: (tab: string) => void }>): JSX.Element => (
  <>
    <div className="flex gap-2 border-b pb-3">
      <Button variant={tab === "monthly" ? "secondary" : "ghost"} onClick={() => setTab("monthly")}>
        Mensual
      </Button>
      <Button variant={tab === "all" ? "secondary" : "ghost"} onClick={() => setTab("all")}>
        Todos los recurrentes
      </Button>
    </div>
  </>
);

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
      <details className="p-5">
        <summary className="cursor-pointer text-sm font-medium">
          Crear desde una transacción
        </summary>
        <TransactionPicker
          disabled={disabled}
          choose={(transaction) =>
            setInitial(planFromTransaction({ transaction, timeZone: panel.initial.timeZone }))
          }
        />
      </details>
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
