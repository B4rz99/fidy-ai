import { PendingRead } from "@/ui/components/pending-read";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { Option } from "effect";
import { createContext, useContext, useId, useState } from "react";
import type { FormEvent, JSX, ReactNode } from "react";
import { Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import {
  revalidateWorkspaceQuery,
  workspaceCategoriesQuery,
  workspaceQueryRetention,
} from "@/transport/workspace-query";
import { Button } from "@/ui/components/button";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { DashboardBudgetDialog } from "@/ui/components/dashboard-budget-dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/ui/components/empty";
import { Label } from "@/ui/components/label";

import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import type { BudgetTarget, BudgetWidget, DashboardGesture } from "./editor-model";
import type { DashboardLayout, DashboardView } from "./presentation";

type Configuration = Readonly<{
  disabled: boolean;
  open: (widget: BudgetWidget) => void;
}>;
const BudgetConfiguration = createContext<Option.Option<Configuration>>(Option.none());

export const ConfigureBudgetButton = ({
  widget,
  compact,
}: Readonly<{ widget: BudgetWidget; compact: boolean }>): JSX.Element => {
  const configuration = useContext(BudgetConfiguration);
  if (Option.isNone(configuration)) return <></>;
  return (
    <Button
      aria-label={compact ? "Configurar presupuesto" : undefined}
      disabled={configuration.value.disabled}
      onClick={() => configuration.value.open(widget)}
      size={compact ? "icon" : "default"}
      type="button"
      variant={compact ? "ghost" : "default"}
    >
      {compact ? (
        <HugeiconsIcon icon={Settings01Icon} strokeWidth={1.5} aria-hidden="true" />
      ) : (
        "Elegir presupuesto"
      )}
    </Button>
  );
};

const findBudgetWidget = (layout: DashboardLayout, id: string): Option.Option<BudgetWidget> => {
  if (layout.kind === "leaf") {
    const { widget } = layout.widget;
    return widget.id === id && widget.type === "budget-bar" ? Option.some(widget) : Option.none();
  }
  return Option.fromUndefinedOr(
    layout.children.flatMap(({ node }) => Option.toArray(findBudgetWidget(node, id)))[0]
  );
};

type ConfigurationProps = Readonly<{
  apiClient: FidyClient;
  children: ReactNode;
  disabled: boolean;
  view: DashboardView;
  onGesture: (gesture: DashboardGesture) => void;
}>;
export const DashboardBudgetConfiguration = ({
  apiClient,
  children,
  disabled,
  view,
  onGesture,
}: ConfigurationProps): JSX.Element => {
  const [selectedId, setSelectedId] = useState(() => Option.none<BudgetWidget["id"]>());
  const widget = Option.flatMap(selectedId, (id) => findBudgetWidget(view.layout, id));
  const close = (): void => setSelectedId(Option.none());
  return (
    <BudgetConfiguration
      value={Option.some({
        disabled,
        open: (target) => {
          setSelectedId(Option.some(target.id));
        },
      })}
    >
      {children}
      <DashboardBudgetDialog open={Option.isSome(widget)} onClose={close}>
        {Option.isSome(widget) ? (
          <BudgetConfigurationContent
            key={`${widget.value.id}:${view.context.timeZone}`}
            apiClient={apiClient}
            timeZone={view.context.timeZone}
            widget={widget.value}
            disabled={disabled}
            onClose={close}
            onSave={(target) => {
              if (disabled) return;
              onGesture({ kind: "configure-budget", widget: widget.value, target });
              close();
            }}
          />
        ) : null}
      </DashboardBudgetDialog>
    </BudgetConfiguration>
  );
};

type BudgetChoice = BudgetTarget & Readonly<{ value: string; label: string }>;
type Category = CanonicalSuccess<"categories.listCategories">["data"][number];
type BudgetStatus = CanonicalSuccess<"budgets.getBudgetStatus">["data"]["statuses"][number];
const budgetChoices = (
  statuses: ReadonlyArray<BudgetStatus>,
  categories: ReadonlyArray<Category>
): ReadonlyArray<BudgetChoice> =>
  statuses
    .flatMap(({ budget }) => {
      const category = categories.find(({ id }) => id === budget.categoryId);
      return category === undefined
        ? []
        : [
            {
              value: budget.id,
              label: `${category.label} · ${budget.cap.currency}`,
              categoryId: budget.categoryId,
              currency: budget.cap.currency,
            },
          ];
    })
    .sort((first, second) => first.label.localeCompare(second.label, "es-CO"));

type ContentProps = Readonly<{
  apiClient: FidyClient;
  timeZone: DashboardView["context"]["timeZone"];
  widget: BudgetWidget;
  disabled: boolean;
  onClose: () => void;
  onSave: (target: BudgetTarget) => void;
}>;
const BudgetConfigurationContent = ({
  apiClient,
  timeZone,
  ...form
}: ContentProps): JSX.Element => {
  const [budgetsQuery] = useState(() =>
    apiClient
      .query("budgets", "getBudgetStatus", {
        ...workspaceQueryRetention,
        reactivityKeys: ["budgets"],
        query: { timeZone },
      })
      .pipe(revalidateWorkspaceQuery)
  );
  const categoriesQuery = workspaceCategoriesQuery(apiClient).view;
  const budgetsResult = useAtomValue(budgetsQuery);
  const categoriesResult = useAtomValue(categoriesQuery);
  const budgets = presentCanonicalQuery(budgetsResult);
  const categories = presentCanonicalQuery(categoriesResult);
  const refreshBudgets = useAtomRefresh(budgetsQuery);
  const refreshCategories = useAtomRefresh(categoriesQuery);
  const waiting = budgets.waiting || categories.waiting;
  const retry = (
    <CanonicalQueryRetry
      retryLabel="Reintentar carga de presupuestos"
      retryingLabel="Reintentando…"
      title="No pudimos cargar los presupuestos"
      description="Actualiza las opciones antes de guardar."
      waiting={waiting}
      onRetry={() => {
        refreshBudgets();
        refreshCategories();
      }}
    />
  );
  if (budgets._tag === "Initial" || categories._tag === "Initial") {
    return <PendingRead label="Cargando presupuestos" />;
  }
  if (budgets._tag !== "Ready" || categories._tag !== "Ready") return retry;
  if ([budgets.refreshFailure, categories.refreshFailure].some(Option.isSome)) return retry;
  return (
    <BudgetConfigurationForm
      {...form}
      disabled={form.disabled || waiting}
      choices={budgetChoices(budgets.value.data.statuses, categories.value.data)}
    />
  );
};

const BudgetConfigurationForm = ({
  widget,
  disabled,
  choices,
  onClose,
  onSave,
}: Omit<ContentProps, "apiClient" | "timeZone"> &
  Readonly<{ choices: ReadonlyArray<BudgetChoice> }>): JSX.Element => {
  const id = useId();
  const [selectedId, setSelectedId] = useState(
    () =>
      choices.find(
        (choice) => choice.categoryId === widget.categoryId && choice.currency === widget.currency
      )?.value ?? ""
  );
  const selected = choices.find(({ value }) => value === selectedId);
  if (choices.length === 0) return <NoBudgetChoices onClose={onClose} />;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!disabled && selected !== undefined) {
      onSave({ categoryId: selected.categoryId, currency: selected.currency });
    }
  };
  return (
    <form className="grid gap-6" onSubmit={submit}>
      <div className="grid gap-3">
        <Label htmlFor={id}>Presupuesto</Label>
        <ChoiceDropdown
          id={id}
          label="Presupuesto"
          value={selectedId}
          options={choices}
          disabled={disabled}
          width="full"
          leading={null}
          onChange={setSelectedId}
          triggerLabel={
            selected === undefined ? Option.some("Elige un presupuesto") : Option.none()
          }
        />
        <p className="text-sm text-muted-foreground">
          Solo aparecen presupuestos existentes para el mes actual.
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        Verás el presupuesto y los gastos del mes actual en su moneda original.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" disabled={disabled || selected === undefined}>
          Guardar cambios
        </Button>
      </div>
    </form>
  );
};

const NoBudgetChoices = ({ onClose }: Readonly<{ onClose: () => void }>): JSX.Element => (
  <Empty>
    <EmptyHeader>
      <EmptyTitle>No tienes presupuestos para este mes</EmptyTitle>
      <EmptyDescription>
        Crea un presupuesto en Presupuestos y vuelve para elegirlo.
      </EmptyDescription>
    </EmptyHeader>
    <Link to="/app/budgets" onClick={onClose}>
      Ir a Presupuestos
    </Link>
  </Empty>
);
