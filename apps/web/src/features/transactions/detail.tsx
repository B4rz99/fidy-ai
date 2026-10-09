import { Option } from "effect";
import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import type { FidyClient } from "@/transport/client";
import type { DetailMode } from "./panel-state";
import { TransactionCorrection } from "./correction";
import { type Category, type Transaction, presentTransactionRows } from "./presentation";

type DetailProps = Readonly<{
  renderPanel: (content: JSX.Element) => JSX.Element;
  apiClient: FidyClient;
  transaction: Transaction;
  categories: ReadonlyArray<Category>;
  locale: string;
  timeZone: string;
  onSaved: () => void;
  onRefresh: () => void;
  onClose: () => void;
  editable: boolean;
  mode: DetailMode;
  onMode: (mode: DetailMode) => void;
}>;
const DetailFacts = ({ transaction, categories, locale, timeZone }: DetailProps): JSX.Element => {
  const row = Option.getOrThrow(
    Option.fromNullishOr(
      presentTransactionRows({
        transactions: [transaction],
        categories,
        locale,
        timeZone,
        counterpartyFallback: "Contraparte no identificada",
      })[0]
    )
  );
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-muted-foreground">{row.counterpartyLabel}</p>
        <p className="mt-2 text-2xl font-semibold tabular-nums">{row.moneyText}</p>
      </div>
      <dl className="grid grid-cols-2 gap-4 text-sm">
        <dt className="text-muted-foreground">Tipo</dt>
        <dd>{row.transactionTypeLabel}</dd>
        <dt className="text-muted-foreground">Categoría</dt>
        <dd>{row.categoryLabel}</dd>
        <dt className="text-muted-foreground">Fecha</dt>
        <dd>{row.occurredOnText}</dd>
        <dt className="text-muted-foreground">Zona horaria</dt>
        <dd className="break-words">{timeZone}</dd>
        <dt className="text-muted-foreground">Notas</dt>
        <dd className="break-words">{Option.getOrElse(transaction.notes, () => "Sin notas")}</dd>
      </dl>
    </div>
  );
};
const DetailFrame = ({
  props,
  children,
}: Readonly<{ props: DetailProps; children: JSX.Element }>): JSX.Element => (
  <section aria-label="Detalle de transacción" className="flex flex-col gap-6">
    <header className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">Detalle de transacción</h2>
      <Button
        size="sm"
        variant="ghost"
        onClick={props.onClose}
        aria-label="Cerrar detalle"
        disabled={props.mode._tag === "Editing" && props.mode.status === "saving"}
      >
        Cerrar
      </Button>
    </header>
    {children}
  </section>
);
/** Keeps mutation and draft ownership above the responsive layout boundary. */
export const TransactionDetail = (props: DetailProps): JSX.Element => {
  if (props.mode._tag === "Editing") {
    return (
      <TransactionCorrection
        renderForm={(form) => props.renderPanel(<DetailFrame props={props}>{form}</DetailFrame>)}
        apiClient={props.apiClient}
        transaction={props.transaction}
        categories={props.categories}
        timeZone={props.timeZone}
        onSaved={() => {
          props.onMode({ _tag: "Viewing" });
          props.onSaved();
        }}
        onCancel={() => props.onMode({ _tag: "Viewing" })}
        onRefresh={props.onRefresh}
        status={props.mode.status}
        onStatus={(status) => props.onMode({ _tag: "Editing", status })}
      />
    );
  }
  return props.renderPanel(
    <DetailFrame props={props}>
      <>
        <DetailFacts {...props} />
        <Button
          variant="outline"
          disabled={!props.editable}
          onClick={() => props.onMode({ _tag: "Editing", status: "idle" })}
        >
          Editar transacción
        </Button>
      </>
    </DetailFrame>
  );
};
