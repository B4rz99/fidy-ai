import { Alert, AlertDescription } from "@/ui/components/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/ui/components/empty";
import "./layout.css";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { useNavigate } from "@tanstack/react-router";
import { BigDecimal, Array as EffectArray, Option } from "effect";
import { type JSX, useState } from "react";
import { Button } from "@/ui/components/button";
import { WorkspaceColumns, WorkspaceHeader } from "@/ui/components/workspace-layout";
import { WorkspacePanel } from "@/ui/components/workspace-panel";
import { BudgetBalance } from "@/ui/components/budget-meter";
import {
  type BudgetReport,
  type BudgetStatus,
  budgetFigures,
  defaultBudgetGroup,
} from "./presentation";
import { type BudgetController, useBudgetController } from "./controller";
import { BudgetEditor } from "./editor";
import { BudgetRow } from "./row";
import { BudgetSummary } from "./summary";
import {
  type WorkspaceProps,
  currentBudgetMonth,
  groupFor,
  monthShift,
  monthTitle,
  rowDraft,
} from "./model";

const expandedRowLimit = 50;

type ViewProps = Readonly<{
  props: WorkspaceProps;
  controller: BudgetController;
}>;
const BudgetToolbar = ({ props, controller }: ViewProps): JSX.Element => {
  const navigate = useNavigate();
  const move = (month: string): void => {
    if (!controller.disabled) {
      navigate({ to: "/app/budgets", search: { month } }).catch(() => undefined);
    }
  };
  return (
    <WorkspaceHeader
      title="Presupuestos"
      context={
        <p className="mt-1 text-sm capitalize text-muted-foreground">
          {monthTitle({ month: props.month, user: props.user })}
        </p>
      }
    >
      <Button
        variant="outline"
        size="icon"
        aria-label="Mes anterior"
        disabled={controller.disabled}
        onClick={() => move(monthShift({ month: props.month, offset: -1 }))}
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={1.5} />
      </Button>
      <Button
        variant="outline"
        size="icon"
        aria-label="Mes siguiente"
        disabled={controller.disabled}
        onClick={() => move(monthShift({ month: props.month, offset: 1 }))}
      >
        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={1.5} />
      </Button>
      <Button
        variant="outline"
        disabled={controller.disabled || props.month === currentBudgetMonth(props.user)}
        onClick={() => move(currentBudgetMonth(props.user))}
      >
        Hoy
      </Button>
      <Button
        variant="outline"
        disabled={controller.saveState === "saving"}
        onClick={controller.refresh}
      >
        Actualizar
      </Button>
    </WorkspaceHeader>
  );
};
const BudgetFeedback = ({ props, controller }: ViewProps): JSX.Element => {
  const freeze = (): void =>
    Option.match(EffectArray.head(props.report.statuses), {
      onNone: () => undefined,
      onSome: (first) =>
        controller.write({
          target: rowDraft({ status: first, categories: props.categories }),
          amount: BigDecimal.format(first.budget.cap.amount),
          currency: first.budget.cap.currency,
          groupCurrency: Option.none(),
          groupName: groupFor({ status: first, categories: props.categories }),
        }),
    });
  return (
    <div className="px-5 empty:hidden [&:not(:empty)]:pt-4" aria-live="polite">
      {controller.saveState === "saving" ? (
        <Alert role="note" variant="pending">
          <AlertDescription>Guardando presupuesto…</AlertDescription>
        </Alert>
      ) : null}
      {controller.saveState === "saved" ? (
        <Alert role="note" variant="success">
          <AlertDescription>Presupuesto guardado.</AlertDescription>
        </Alert>
      ) : null}
      {controller.saveState === "failed" ? (
        <Alert variant="destructive">
          <AlertDescription>
            No se pudo guardar. Usa un importe positivo con la precisión de su moneda y un nombre de
            grupo válido.
          </AlertDescription>
        </Alert>
      ) : null}
      {controller.saveState === "uncertain" ? (
        <Alert variant="destructive">
          <AlertDescription>
            No pudimos confirmar el guardado. Actualiza para comprobar el plan antes de volver a
            editar.
          </AlertDescription>
        </Alert>
      ) : null}
      {props.report.initialized === false && props.report.statuses.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            Plan heredado del mes anterior. Sin acumulación de saldos.
          </p>
          <Button variant="outline" disabled={controller.disabled} onClick={freeze}>
            Guardar plan del mes
          </Button>
        </div>
      ) : null}
    </div>
  );
};
const BudgetPanel = ({
  props,
  controller,
  groups,
}: ViewProps & Readonly<{ groups: ReadonlyArray<string> }>): JSX.Element => (
  <WorkspacePanel
    open={Option.isSome(controller.draft)}
    locked={controller.saveState === "saving" || controller.saveState === "uncertain"}
    onClose={() => controller.setDraft(Option.none())}
    title="Configurar presupuesto"
    description="Categoría, importe y grupo del plan mensual."
  >
    {Option.match(controller.draft, {
      onNone: () => <BudgetSummary report={props.report} user={props.user} />,
      onSome: (draft) => (
        <BudgetEditor
          key={`${draft.category.id}:${Option.isSome(draft.groupCategoryIds) ? "group" : "category"}`}
          draft={draft}
          month={props.month}
          groups={groups}
          groupCurrencies={props.report.statuses.map((status) => ({
            group: groupFor({ status, categories: props.categories }),
            currency: status.budget.cap.currency,
          }))}
          disabled={controller.disabled}
          onClose={() => controller.setDraft(Option.none())}
          onSubmit={controller.write}
        />
      ),
    })}
  </WorkspacePanel>
);
const BudgetHead = (): JSX.Element => (
  <div className="budget-head budget-tracks gap-4 rounded-md bg-muted px-4 py-2 text-sm text-muted-foreground">
    <span>Gastos</span>
    <span className="text-right">Presupuesto</span>
    <span className="text-right">Gastado</span>
    <span className="text-right">Disponible</span>
  </div>
);
const BudgetTotals = ({
  report,
  locale,
}: Readonly<{ report: BudgetReport; locale: string }>): JSX.Element => (
  <div className="budget-totals rounded-lg border bg-card px-4 py-4">
    <h2 className="font-semibold">Total de gastos</h2>
    {budgetFigures({ statuses: report.statuses, locale }).map((figure) => (
      <div key={figure.currency} className="budget-tracks mt-3 items-center gap-4">
        <span>{figure.currency}</span>
        <span className="budget-value text-right tabular-nums">
          <span className="budget-value-label">Presupuesto</span>
          {figure.budgeted}
        </span>
        <span className="budget-value text-right tabular-nums">
          <span className="budget-value-label">Gastado</span>
          {figure.spent}
        </span>
        <span className="budget-value text-right tabular-nums">
          <span className="budget-value-label">Disponible</span>
          {figure.remaining}
        </span>
      </div>
    ))}
  </div>
);
type GroupHeadingProps = Readonly<{
  group: string;
  statuses: ReadonlyArray<BudgetStatus>;
  locale: string;
}>;
const GroupHeading = ({
  group,
  statuses,
  locale,
  open,
  onToggle,
  disabled,
  onRename,
}: GroupHeadingProps &
  Readonly<{
    open: boolean;
    onToggle: () => void;
    disabled: boolean;
    onRename: () => void;
  }>): JSX.Element => (
  <header className="budget-group-heading budget-tracks items-center gap-4 px-4 py-3">
    <div className="flex min-w-0 items-center gap-1">
      <h2 className="min-w-0 font-semibold">
        <Button
          variant="disclosure"
          size="label"
          aria-expanded={open}
          onClick={onToggle}
          className="min-w-0 max-w-full"
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={16}
            strokeWidth={1.5}
            className={open ? "shrink-0" : "shrink-0 -rotate-90"}
          />
          <span className="budget-name" title={group}>
            {group}
          </span>
        </Button>
      </h2>
      {statuses.length > 0 ? (
        <GroupRename group={group} disabled={disabled} onRename={onRename} />
      ) : null}
    </div>
    <GroupFigures statuses={statuses} locale={locale} />
  </header>
);
const Unbudgeted = ({
  group,
  props,
  controller,
}: ViewProps & Readonly<{ group: string }>): JSX.Element => {
  const categories = props.categories.filter(
    (category) =>
      defaultBudgetGroup(category.label) === group &&
      !props.report.statuses.some((status) => status.budget.categoryId === category.id)
  );
  if (categories.length === 0) {
    return <></>;
  }
  return (
    <details className="budget-unbudgeted group/unbudgeted border-t">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm text-muted-foreground [&::-webkit-details-marker]:hidden">
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={16}
          strokeWidth={1.5}
          aria-hidden="true"
          className="shrink-0 -rotate-90 group-open/unbudgeted:rotate-0"
        />
        Mostrar {categories.length} sin presupuesto
      </summary>
      <div className="flex flex-col gap-1 p-3">
        {categories.map((category) => (
          <div key={category.id} className="flex items-center justify-between gap-3 px-1 py-2">
            <span>{category.label}</span>
            <Button
              variant="outline"
              disabled={controller.disabled}
              onClick={() =>
                controller.setDraft(
                  Option.some({
                    category,
                    budget: Option.fromUndefinedOr(
                      props.budgets.find((budget) => budget.categoryId === category.id)
                    ),
                    groupCategoryIds: Option.none(),
                  })
                )
              }
            >
              Asignar presupuesto
            </Button>
          </div>
        ))}
      </div>
    </details>
  );
};
const GroupRename = ({
  group,
  disabled,
  onRename,
}: Readonly<{
  group: string;
  disabled: boolean;
  onRename: () => void;
}>): JSX.Element => (
  <Button
    className="shrink-0"
    size="icon"
    variant="ghost"
    aria-label={`Configurar grupo ${group}`}
    disabled={disabled}
    onClick={onRename}
  >
    <HugeiconsIcon icon={Settings01Icon} strokeWidth={1.5} />
  </Button>
);
const editGroupAmount = (
  { group, props, controller }: ViewProps & Readonly<{ group: string }>,
  status: BudgetStatus,
  amount: string
): void =>
  controller.write({
    target: rowDraft({ status, categories: props.categories }),
    amount,
    currency: status.budget.cap.currency,
    groupCurrency: Option.none(),
    groupName: group,
  });
const BudgetGroup = ({
  group,
  props,
  controller,
}: ViewProps & Readonly<{ group: string }>): JSX.Element => {
  const [open, setOpen] = useState(props.report.statuses.length <= expandedRowLimit);
  const statuses = props.report.statuses.filter(
    (status) => groupFor({ status, categories: props.categories }) === group
  );
  const rename = (): void =>
    Option.match(EffectArray.head(statuses), {
      onNone: () => undefined,
      onSome: (first) =>
        controller.setDraft(
          Option.some({
            ...rowDraft({ status: first, categories: props.categories }),
            groupCategoryIds: Option.some(statuses.map((status) => status.budget.categoryId)),
          })
        ),
    });
  return (
    <section className="budget-group relative rounded-lg border bg-card">
      <GroupHeading
        group={group}
        statuses={statuses}
        locale={props.user.locale}
        open={open}
        onToggle={() => setOpen(!open)}
        disabled={controller.disabled}
        onRename={rename}
      />
      {open ? (
        <>
          {statuses.map((status) => {
            const draft = rowDraft({ status, categories: props.categories });
            return (
              <BudgetRow
                key={`${status.budget.id}:${BigDecimal.format(status.budget.cap.amount)}:${controller.refreshVersion}`}
                status={status}
                category={draft.category}
                user={props.user}
                disabled={controller.disabled}
                onSave={(status, amount) =>
                  editGroupAmount({ group, props, controller }, status, amount)
                }
                onSettings={() => controller.setDraft(Option.some(draft))}
              />
            );
          })}
          <Unbudgeted group={group} props={props} controller={controller} />
        </>
      ) : null}
    </section>
  );
};
export const BudgetWorkspace = (props: WorkspaceProps): JSX.Element => {
  const controller = useBudgetController(props);
  const groups = workspaceGroups(props);
  return (
    <>
      <BudgetToolbar props={props} controller={controller} />
      <BudgetFeedback props={props} controller={controller} />
      <div>
        <WorkspaceColumns
          variant="container"
          panel={<BudgetPanel props={props} controller={controller} groups={groups} />}
        >
          <div className="budget-table-container">
            <div className="budget-table gap-4">
              <BudgetHead />
              {props.report.statuses.length === 0 ? (
                <Empty className="col-span-full">
                  <EmptyHeader>
                    <EmptyTitle>Aún no tienes presupuestos.</EmptyTitle>
                    <EmptyDescription>
                      Elige una categoría para planificar tus gastos.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}
              {groups.map((group) => (
                <BudgetGroup key={group} group={group} props={props} controller={controller} />
              ))}
              {props.report.statuses.length > 0 ? (
                <BudgetTotals report={props.report} locale={props.user.locale} />
              ) : null}
            </div>
          </div>
        </WorkspaceColumns>
      </div>
    </>
  );
};

const GroupFigures = ({
  statuses,
  locale,
}: Pick<GroupHeadingProps, "statuses" | "locale">): JSX.Element => (
  <div className="budget-group-figures">
    {budgetFigures({ statuses, locale }).map((figure) => (
      <div
        key={figure.currency}
        className="budget-figures items-center gap-4 text-right text-sm font-semibold tabular-nums"
      >
        <span className="budget-value">
          <span className="budget-value-label">Presupuesto</span>
          {figure.budgeted}
        </span>
        <span className="budget-value">
          <span className="budget-value-label">Gastado</span>
          {figure.spent}
        </span>
        <div className="budget-value">
          <span className="budget-value-label">Disponible</span>
          <BudgetBalance over={figure.over}>{figure.remaining}</BudgetBalance>
        </div>
      </div>
    ))}
  </div>
);

const workspaceGroups = (props: WorkspaceProps): ReadonlyArray<string> => [
  ...new Set([
    ...props.report.statuses.map((status) => groupFor({ status, categories: props.categories })),
    ...props.categories.flatMap((category) =>
      props.report.statuses.some((status) => status.budget.categoryId === category.id)
        ? []
        : [defaultBudgetGroup(category.label)]
    ),
  ]),
];
