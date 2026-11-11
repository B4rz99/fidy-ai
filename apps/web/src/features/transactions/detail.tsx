import { Option } from "effect";
import { type JSX, use, useState } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import { PendingRead } from "@/ui/components/pending-read";
import { TransactionReconciliation } from "./reconciliation";
import { TransactionCorrectionContext, useTransactionCorrections } from "./correction-context";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { CategoryVisual } from "@/ui/components/category-visual";
import { Button } from "@/ui/components/button";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import { type DetailMode, reconciliationLocked } from "./panel-state";
import { TransactionCorrection } from "./correction";
import { TransactionDeletion } from "./deletion";
import {
  type CaptureSources,
  type Category,
  type LinkedPair,
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
  inspectable: boolean;
  mode: DetailMode;
  onMode: (mode: DetailMode) => void;
}>;
type InspectedProps = DetailProps &
  Readonly<{
    pair: Option.Option<LinkedPair>;
    sources: CaptureSources;
    selectedId: Transaction["id"];
    historyTransaction: Transaction;
    correctionReady: boolean;
    inspectionChanged: boolean;
    inspectionWaiting: boolean;
    inspectionFailed: boolean;
    refreshInspection: () => void;
  }>;
const relationshipLocked = (mode: DetailMode): boolean =>
  mode._tag === "Reconciling" && reconciliationLocked(mode);
const TransactionRelationship = ({ props }: Readonly<{ props: InspectedProps }>): JSX.Element => {
  if (props.mode._tag === "Reconciling" || !props.inspectable) {
    return <></>;
  }
  if (props.inspectionWaiting && Option.isNone(props.pair)) {
    return <PendingRead label="Consultando vínculo" />;
  }
  if (props.inspectionFailed) {
    return (
      <div className="mt-4 flex flex-col gap-2">
        <output className="text-sm">No pudimos consultar el vínculo.</output>
        <Button variant="outline" onClick={props.refreshInspection}>
          Actualizar vínculo
        </Button>
      </div>
    );
  }
  return Option.match(props.pair, {
    onNone: () => <></>,
    onSome: (pair) => (
      <div className="my-4 flex flex-wrap items-center justify-between gap-3 border-y border-border py-4">
        <div>
          <p className="text-sm font-semibold">Vinculada</p>
          <p className="text-sm text-muted-foreground">
            Dos registros cuentan como una transacción.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={
            props.inspectionWaiting ||
            relationshipLocked(props.mode) ||
            (props.mode._tag === "Deleting" && !["idle", "rejected"].includes(props.mode.status))
          }
          onClick={() =>
            props.onMode({
              _tag: "Reconciling",
              pair,
              sources: props.sources,
              deleting: props.mode._tag === "Deleting",
              status: "review",
            })
          }
        >
          {props.mode._tag === "Deleting" ? "Revisar vínculo" : "Ver vínculo"}
        </Button>
      </div>
    ),
  });
};
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
const DetailDeleteButton = ({ props }: Readonly<{ props: InspectedProps }>): JSX.Element => {
  const owner = useTransactionCorrections();
  return (
    <Button
      variant="outline"
      data-transaction-slot="transaction-danger"
      onClick={() => {
        if (owner.reviewDeletion(props.transaction.id)) {
          props.onMode({ _tag: "Deleting", status: "idle", original: Option.none() });
        }
      }}
    >
      <HugeiconsIcon icon={Delete02Icon} size={20} aria-hidden="true" />
      Eliminar transacción
    </Button>
  );
};
const DetailDeleteAction = ({ props }: Readonly<{ props: InspectedProps }>): JSX.Element =>
  props.editable && props.mode._tag !== "Deleting" && props.mode._tag !== "Reconciling" ? (
    <DetailDeleteButton props={props} />
  ) : (
    <></>
  );
const detailTitle = (mode: DetailMode): string => {
  if (mode._tag === "Reconciling") return "Revisar vínculo";
  return mode._tag === "Deleting" ? "Eliminar transacción" : "Detalle de transacción";
};
const DetailClose = ({ props }: Readonly<{ props: InspectedProps }>): JSX.Element => {
  const corrections = use(TransactionCorrectionContext);
  const busy = Option.exists(
    corrections,
    (owner) =>
      owner.status === "saving" || owner.status === "recovering" || owner.status === "refreshing"
  );
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={props.onClose}
      aria-label="Cerrar detalle"
      disabled={
        relationshipLocked(props.mode) ||
        (props.mode._tag === "Deleting" && props.mode.status === "saving") ||
        busy
      }
    >
      <HugeiconsIcon icon={Cancel01Icon} size={20} aria-hidden="true" />
    </Button>
  );
};
const DetailFrame = ({
  props,
  children,
}: Readonly<{ props: InspectedProps; children: JSX.Element }>): JSX.Element => (
  <section aria-label="Detalle de transacción" className="flex flex-col gap-6">
    <header className="flex items-center justify-between gap-3">
      <h2>{detailTitle(props.mode)}</h2>
      <DetailClose props={props} />
    </header>
    {props.mode._tag !== "Reconciling" ? <DetailIdentity {...props} /> : null}
    {props.mode._tag === "Deleting" ||
    props.mode._tag === "Viewing" ||
    (props.mode._tag === "Editing" && !props.correctionReady) ? (
      <p data-transaction-slot="transaction-detail-value">{detailRow(props).moneyText}</p>
    ) : null}
    <TransactionRelationship props={props} />
    {children}
    <DetailDeleteAction props={props} />
  </section>
);
const ReconciliationPanel = ({
  props,
}: Readonly<{
  props: InspectedProps & { mode: Extract<DetailMode, { _tag: "Reconciling" }> };
}>): JSX.Element => {
  const owner = useTransactionCorrections();
  return props.renderPanel(
    <DetailFrame props={props}>
      <TransactionReconciliation
        {...props}
        selectedId={props.selectedId}
        onMode={props.onMode}
        onCancel={() => {
          if (props.mode.deleting) owner.reviewDeletion(props.transaction.id);
          props.onMode(
            props.mode.deleting
              ? { _tag: "Deleting", status: "idle", original: Option.none() }
              : { _tag: "Editing" }
          );
        }}
        onHistory={props.onRefresh}
        onDelete={(original) => {
          if (owner.reviewDeletion(original.id)) {
            props.onMode({ _tag: "Deleting", status: "idle", original: Option.some(original) });
          }
        }}
      />
    </DetailFrame>
  );
};
const DeletionPanel = ({
  props,
}: Readonly<{
  props: InspectedProps & { mode: Extract<DetailMode, { _tag: "Deleting" }> };
}>): JSX.Element => {
  const owner = useTransactionCorrections();
  return props.renderPanel(
    <DetailFrame props={props}>
      <TransactionDeletion
        transaction={props.transaction}
        editable={
          (props.editable || Option.contains(owner.reviewingDeletion, props.transaction.id)) &&
          (Option.isSome(props.mode.original) ||
            (Option.isNone(props.pair) && !props.inspectionWaiting))
        }
        onDeleted={props.onDeleted}
        onCancel={() =>
          Option.isSome(props.mode.original) ? props.onRefresh() : props.onMode({ _tag: "Editing" })
        }
        onRefresh={props.onRefresh}
      />
    </DetailFrame>
  );
};
// Admission uses the inspected revision; the mounted Correction then owns its draft and
// canonical history recovery, including revisions newer than that inspection snapshot.
const useEditingAdmission = (input: InspectedProps): boolean => {
  const [admitted, setAdmitted] = useState(false);
  const editing = input.mode._tag === "Editing";
  if (editing && input.correctionReady && !admitted) setAdmitted(true);
  if (!editing && admitted) setAdmitted(false);
  return editing && (input.correctionReady || admitted);
};
const InspectedDetail = (input: InspectedProps): JSX.Element => {
  const editing = useEditingAdmission(input);
  const props =
    input.mode._tag === "Deleting" && Option.isSome(input.mode.original)
      ? { ...input, transaction: input.mode.original.value }
      : input;
  if (props.mode._tag === "Reconciling") {
    return <ReconciliationPanel props={{ ...props, mode: props.mode }} />;
  }
  if (props.mode._tag === "Deleting") {
    return <DeletionPanel props={{ ...props, mode: props.mode }} />;
  }
  if (editing) {
    return (
      <TransactionCorrection
        key={props.transaction.id}
        renderForm={(form) => props.renderPanel(<DetailFrame props={props}>{form}</DetailFrame>)}
        transaction={props.historyTransaction}
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
        {props.inspectionChanged ? (
          <div className="mt-4 flex flex-col gap-3">
            <output>La transacción cambió. Actualiza el historial antes de editar.</output>
            <Button variant="outline" onClick={props.onRefresh}>
              Actualizar historial
            </Button>
          </div>
        ) : null}
      </>
    </DetailFrame>
  );
};

const inspectionFresh = (state: CanonicalQueryState<unknown, unknown>): boolean =>
  state._tag === "Ready" && !state.waiting && Option.isNone(state.refreshFailure);
const inspectionFailed = (state: CanonicalQueryState<unknown, unknown>): boolean =>
  state._tag === "Failure" || (state._tag === "Ready" && Option.isSome(state.refreshFailure));
const inspectionPair = (
  state: CanonicalQueryState<CanonicalSuccess<"transactions.getTransaction">, unknown>
): Option.Option<LinkedPair> =>
  state._tag === "Ready" && state.value.data.reconciliation.kind === "linked"
    ? Option.some(state.value.data.reconciliation)
    : Option.none();
const InspectableDetail = (props: DetailProps): JSX.Element => {
  const [query] = useState(() =>
    props.apiClient.query("transactions", "getTransaction", {
      params: { id: props.transaction.id },
      timeToLive: "0 millis",
      reactivityKeys: ["transaction-detail"],
    })
  );
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  const refreshInspection = useAtomRefresh(query);
  const fresh = inspectionFresh(state);
  const transaction = state._tag === "Ready" ? state.value.data : props.transaction;
  const changed =
    transaction.id !== props.transaction.id || transaction.revision !== props.transaction.revision;
  const pair = inspectionPair(state);
  return (
    <InspectedDetail
      {...props}
      transaction={transaction}
      selectedId={props.transaction.id}
      historyTransaction={props.transaction}
      editable={props.editable && fresh}
      correctionReady={fresh && !changed}
      inspectionChanged={fresh && changed}
      pair={pair}
      sources={state._tag === "Ready" ? state.value.data.sources : []}
      inspectionWaiting={state._tag === "Initial" || state.waiting}
      inspectionFailed={inspectionFailed(state)}
      refreshInspection={refreshInspection}
    />
  );
};
export const TransactionDetail = (props: DetailProps): JSX.Element =>
  props.inspectable ? (
    <InspectableDetail {...props} />
  ) : (
    <InspectedDetail
      {...props}
      pair={Option.none()}
      sources={[]}
      selectedId={props.transaction.id}
      historyTransaction={props.transaction}
      correctionReady={props.editable}
      inspectionChanged={false}
      inspectionWaiting={false}
      inspectionFailed={false}
      refreshInspection={props.onRefresh}
    />
  );
