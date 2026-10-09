import { Option } from "effect";
import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { CategoryVisual } from "./visuals";
import { Button } from "@/ui/components/button";
import type { FidyClient } from "@/transport/client";
import type { DetailMode } from "./panel-state";
import { TransactionCorrection } from "./correction";
import {
  type Category,
  type Transaction,
  type TransactionListRow,
  presentTransactionRows,
} from "./presentation";

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
const detailRow = ({
  transaction,
  categories,
  locale,
  timeZone,
}: Pick<DetailProps, "transaction" | "categories" | "locale" | "timeZone">): TransactionListRow =>
  Option.getOrThrow(
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
const DetailFacts = ({ transaction, categories, locale, timeZone }: DetailProps): JSX.Element => {
  const row = detailRow({ transaction, categories, locale, timeZone });
  return (
    <div className="flex flex-col gap-6">
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
const DetailIdentity = ({
  transaction,
  categories,
  locale,
  timeZone,
}: DetailProps): JSX.Element => {
  const row = detailRow({ transaction, categories, locale, timeZone });
  return (
    <div className="flex items-start gap-5 border-b pb-8">
      <CategoryVisual label={row.categoryLabel} bubble large />
      <div className="min-w-0">
        <p className="text-lg font-semibold">{row.counterpartyLabel}</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">{row.moneyText}</p>
        <p className="mt-1 text-sm text-muted-foreground">{row.dateLabel}</p>
      </div>
    </div>
  );
};
const DetailFrame = ({
  props,
  children,
}: Readonly<{ props: DetailProps; children: JSX.Element }>): JSX.Element => (
  <section aria-label="Detalle de transacción" className="flex flex-col gap-6">
    <header className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">Detalle de la transacción</h2>
      <Button
        size="sm"
        variant="ghost"
        onClick={props.onClose}
        aria-label="Cerrar detalle"
        disabled={props.mode._tag === "Editing" && props.mode.status === "saving"}
      >
        <HugeiconsIcon icon={Cancel01Icon} size={20} aria-hidden="true" />
      </Button>
    </header>
    <DetailIdentity {...props} />
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
