import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { type JSX, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { DateTime, Option } from "effect";
import { Button } from "@/ui/components/button";
import { Badge } from "@/ui/components/badge";
import { WorkspaceColumns, WorkspaceHeader } from "@/ui/components/workspace-layout";
import { WorkspacePanel } from "@/ui/components/workspace-panel";
import { TransactionBrowser } from "./transactions";
import { RecurringSurface } from "@/ui/components/recurring";
import {
  type TransactionBrowserControl,
  type TransactionFilters,
  emptyTransactionFilters,
} from "./transaction-filters";
import { type Occurrence, type Save, expectedAmount, statuses } from "./model";
import { TransactionReview } from "./transaction-review";
import type { CanonicalSuccess } from "@/transport/client";

type Transaction = CanonicalSuccess<"transactions.listTransactions">["data"][number];

type Props = Readonly<{
  item: Occurrence;
  disabled: boolean;
  save: Save;
  close: () => void;
  notice: ReactNode;
  navigation: Option.Option<TransactionBrowserControl>;
}>;

export const TransactionLink = ({
  item,
  disabled,
  save,
  close,
  notice,
  navigation,
}: Props): JSX.Element => {
  const active = useRouterState({
    select: (state) => state.location.pathname === "/app/recurring",
  });

  const initial: TransactionFilters = {
    ...emptyTransactionFilters,
    currency: item.plan.currency,
    direction: item.plan.kind === "income" ? "inflow" : "outflow",
  };

  return (
    <RecurringSurface>
      <main aria-label="Vincular transacción" className="min-w-0 [overflow-wrap:anywhere]">
        <LinkHeader item={item} disabled={disabled} close={close} />
        <TransactionBrowser {...{ disabled, initial, navigation }} timeZone={item.plan.timeZone}>
          {(view) => (
            <WorkspaceColumns
              variant="default"
              panel={
                <WorkspacePanel
                  open={active && Option.isSome(view.selected)}
                  locked={disabled}
                  onClose={view.clear}
                  title="Revisar vínculo"
                  description="Revisa la fecha y el importe antes de vincular la transacción."
                >
                  <LinkReview
                    key={Option.match(view.selected, {
                      onNone: () => "none",
                      onSome: (transaction) => transaction.id,
                    })}
                    {...{ item, save, notice }}
                    disabled={view.blocked}
                    selected={view.selected}
                    clear={view.clear}
                  />
                </WorkspacePanel>
              }
            >
              <p className="mb-6 text-sm text-muted-foreground">
                Encuentra el registro que corresponde a esta ocurrencia.
              </p>
              {view.filters}
              {view.results}
            </WorkspaceColumns>
          )}
        </TransactionBrowser>
      </main>
    </RecurringSurface>
  );
};

const LinkHeader = ({
  item,
  disabled,
  close,
}: Pick<Props, "item" | "disabled" | "close">): JSX.Element => (
  <div data-recurring-slot="link-header">
    <WorkspaceHeader
      title="Vincular transacción"
      context={
        <div className="grid gap-1 text-sm text-muted-foreground">
          <p>
            Recurrentes / {item.plan.name} / {item.expectedDate.split("-").toReversed().join("-")}
          </p>
          <p className="tabular-nums">Importe esperado: {expectedAmount(item)}</p>
        </div>
      }
    >
      <Button contentLayout="wrap" variant="outline" disabled={disabled} onClick={close}>
        <HugeiconsIcon icon={ArrowLeft01Icon} size={20} strokeWidth={1.5} aria-hidden="true" />
        Volver a la ocurrencia
      </Button>
    </WorkspaceHeader>
  </div>
);

type ReviewProps = Pick<Props, "item" | "save" | "disabled" | "notice"> &
  Readonly<{ selected: Option.Option<Transaction>; clear: () => void }>;

const LinkReview = ({
  item,
  selected,
  disabled,
  save,
  clear,
  notice,
}: ReviewProps): JSX.Element => (
  <div className="grid min-w-0 gap-5 [overflow-wrap:anywhere]">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">Revisar vínculo</h2>
      {Option.isSome(selected) ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Cerrar revisión"
          disabled={disabled}
          onClick={clear}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={20} strokeWidth={1.5} aria-hidden="true" />
        </Button>
      ) : null}
    </div>
    <OccurrenceSummary item={item} />
    {notice}
    {Option.isNone(selected) ? (
      <div className="grid gap-3 py-5">
        <h3 className="font-semibold">Elige una transacción</h3>
        <p className="text-sm text-muted-foreground">
          Revisa su fecha e importe antes de vincularla a esta ocurrencia. Seleccionar un resultado
          todavía no lo vincula.
        </p>
      </div>
    ) : (
      <TransactionReview item={item} transaction={selected.value} disabled={disabled} save={save} />
    )}
  </div>
);

const OccurrenceSummary = ({ item }: Pick<Props, "item">): JSX.Element => (
  <div className="grid min-w-0 gap-2 bg-secondary p-5 dark:bg-muted">
    <p className="text-xs text-muted-foreground">
      Ocurrencia de{" "}
      {DateTime.format(DateTime.makeUnsafe(`${item.date}T12:00:00Z`), {
        locale: "es-CO",
        month: "long",
        timeZone: "UTC",
      })}
    </p>
    <h3 className="text-lg font-semibold">{item.plan.name}</h3>
    <p className="text-sm text-muted-foreground">
      {item.expectedDate.split("-").toReversed().join("-")}
    </p>
    <strong className="tabular-nums">{expectedAmount(item)}</strong>
    <Badge variant={item.status === "completed" ? "success" : "pending"}>
      {statuses[item.status]}
    </Badge>
  </div>
);
