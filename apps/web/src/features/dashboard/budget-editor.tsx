import { budgetChoices } from "./budget-options";
import type { BudgetChoice } from "./budget-options";
import { PendingRead } from "@/ui/components/pending-read";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { Option } from "effect";
import { useId, useState } from "react";
import type { FormEvent, JSX, ReactNode } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import type { FidyClient } from "@/transport/client";
import {
  revalidateWorkspaceQuery,
  workspaceCategoriesQuery,
  workspaceQueryRetention,
} from "@/transport/workspace-query";
import { Button } from "@/ui/components/button";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/ui/components/empty";
import { Label } from "@/ui/components/label";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import type { BudgetTarget, BudgetWidget } from "./editor-model";
import type { DashboardView } from "./presentation";

type ContentProps = Readonly<{
  apiClient: FidyClient;
  timeZone: DashboardView["context"]["timeZone"];
  widget: BudgetWidget;
  disabled: boolean;
  onClose: () => void;
  onSave: (target: BudgetTarget) => void;
}>;
export const DashboardBudgetEditor = ({
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
      choices={budgetChoices({
        statuses: budgets.value.data.statuses,
        categories: categories.value.data,
      })}
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
      <BudgetConfigurationFields
        id={id}
        disabled={disabled || selected === undefined}
        onClose={onClose}
        selection={
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
        }
      />
    </form>
  );
};

export const BudgetConfigurationFields = ({
  id,
  disabled,
  onClose,
  selection,
}: Readonly<{
  id: string;
  disabled: boolean;
  onClose: () => void;
  selection: ReactNode;
}>): JSX.Element => (
  <>
    <div className="grid gap-3">
      <Label htmlFor={id}>Presupuesto</Label>
      {selection}
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
      <Button type="submit" disabled={disabled}>
        Guardar cambios
      </Button>
    </div>
  </>
);

export const NoBudgetChoices = ({ onClose }: Readonly<{ onClose: () => void }>): JSX.Element => (
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
