import { Option } from "effect";
import { type JSX, use } from "react";
import { TransactionCorrectionContext } from "./correction-context";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { CategoryVisual } from "@/ui/components/category-visual";
import { Button } from "@/ui/components/button";
import type { FidyClient } from "@/transport/client";
import type { DetailMode } from "./panel-state";
import { TransactionCorrection } from "./correction";
import { TransactionDeletion } from "./deletion";
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
  onDeleted: () => void;
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
    <div data-transaction-slot="transaction-detail-identity">
      <CategoryVisual label={row.categoryLabel} bubble large={false} />
      <div className="min-w-0">
        <p className="text-lg font-semibold">{row.counterpartyLabel}</p>

        <p className="text-sm text-muted-foreground">
          {row.dateLabel} · {transaction.money.currency}
        </p>
      </div>
    </div>
  );
};
const DetailDeleteAction = ({ props }: Readonly<{ props: DetailProps }>): JSX.Element => (
  <>
    {props.editable && props.mode._tag !== "Deleting" ? (
      <Button
        variant="outline"
        data-transaction-slot="transaction-danger"

        onClick={() => props.onMode({ _tag: "Deleting", status: "idle" })}
      >
        <HugeiconsIcon icon={Delete02Icon} size={20} aria-hidden="true" />
        Eliminar transacción
      </Button>
    ) : null}
  </>
);
const DetailFrame = ({
  props,
  children,
}: Readonly<{ props: DetailProps; children: JSX.Element }>): JSX.Element => (
  <section aria-label="Detalle de transacción" className="flex flex-col gap-6">
    <header className="flex items-center justify-between gap-3">
      <h2>{props.mode._tag === "Deleting" ? "Eliminar transacción" : "Detalle de transacción"}</h2>
      <Button
        size="sm"
        variant="ghost"
        onClick={
          props.mode._tag === "Deleting" && props.mode.status !== "idle"
            ? props.onRefresh
            : props.onClose
        }
        aria-label="Cerrar detalle"
        disabled={
          (props.mode._tag === "Deleting" && props.mode.status === "saving") ||
          Option.exists(
            use(TransactionCorrectionContext),
            (owner) => owner.status === "saving" || owner.status === "recovering"
          )
        }
      >
        <HugeiconsIcon icon={Cancel01Icon} size={20} aria-hidden="true" />
      </Button>
    </header>
    <DetailIdentity {...props} />
    {props.mode._tag === "Deleting" || props.mode._tag === "Viewing" ? (
      <p data-transaction-slot="transaction-detail-value">{detailRow(props).moneyText}</p>
    ) : null}
    {children}
    <DetailDeleteAction props={props} />
  </section>
);
export const TransactionDetail = (props: DetailProps): JSX.Element => {
  if (props.mode._tag === "Deleting") {
    return props.renderPanel(
      <DetailFrame props={props}>
        <TransactionDeletion
          apiClient={props.apiClient}
          transaction={props.transaction}
          editable={props.editable}
          status={props.mode.status}
          onStatus={(status) => props.onMode({ _tag: "Deleting", status })}
          onDeleted={props.onDeleted}
          onCancel={() => props.onMode({ _tag: "Editing" })}
          onRefresh={props.onRefresh}
        />
      </DetailFrame>
    );
  }
  if (props.mode._tag === "Editing") {
    return (
      <TransactionCorrection
        key={`${props.transaction.id}:${props.transaction.revision}`}
        renderForm={(form) => props.renderPanel(<DetailFrame props={props}>{form}</DetailFrame>)}
        transaction={props.transaction}
        categories={props.categories}
        timeZone={props.timeZone}
        onCancel={props.onClose}
      />
    );
  }
  return props.renderPanel(
    <DetailFrame props={props}>
      <>
        <DetailFacts {...props} />
      </>
    </DetailFrame>
  );
};
