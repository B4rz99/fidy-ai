import { useAtomSet } from "@effect/atom-react";
import { Cause, Effect, Option, Predicate } from "effect";
import { type Atom, Reactivity } from "effect/reactivity";
import { type JSX, useRef, useState } from "react";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import { formatMoneyWithCode } from "@/transport/money";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import type { ReconciliationMode } from "./panel-state";
import {
  type CaptureSources,
  type Category,
  type OriginalTransactions,
  type Transaction,
  presentTransactionRows,
} from "./presentation";

type Recovery = CanonicalSuccess<"transactions.getTransaction">["data"];
type Command =
  | Readonly<{
      kind: "unlink";
      pair: OriginalTransactions;
      completed: (pair: OriginalTransactions) => void;
      failed: (status: "rejected" | "uncertain") => void;
    }>
  | Readonly<{
      kind: "recover";
      id: Transaction["id"];
      completed: (data: Recovery) => void;
      missing: () => void;
      failed: () => void;
    }>;
const missingFailure = (error: unknown): boolean => Predicate.isTagged(error, "NotFound");
const refusedFailure = (error: unknown): boolean =>
  Predicate.isTagged(error, "ValidationFailed") ||
  missingFailure(error) ||
  Predicate.isTagged(error, "ResourceLimited");
const projectionKeys = ["budgets", "dashboard", "recurring-plans"];
const makeCommand = (apiClient: FidyClient): Atom.AtomResultFn<Command, void, never> =>
  apiClient.runtime.fn<Command>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        if (command.kind === "unlink") {
          const response = yield* client.transactions.unlinkTransactions({
            payload: {
              firstTransactionId: command.pair.firstTransaction.id,
              secondTransactionId: command.pair.secondTransaction.id,
            },
          });
          yield* Reactivity.invalidate(projectionKeys);
          command.completed(response.data);
        } else {
          const response = yield* client.transactions.getTransaction({
            params: { id: command.id },
          });
          yield* Reactivity.invalidate(projectionKeys);
          command.completed(response.data);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const failure = Cause.findErrorOption(cause);
            if (command.kind === "recover") {
              if (Option.exists(failure, missingFailure)) command.missing();
              else command.failed();
              return;
            }
            const refused = Option.exists(failure, refusedFailure);
            if (!refused) yield* Reactivity.invalidate(projectionKeys);
            command.failed(refused ? "rejected" : "uncertain");
          })
        )
      ),
    { concurrent: false }
  );

type Props = Readonly<{
  apiClient: FidyClient;
  mode: ReconciliationMode;
  onMode: (mode: ReconciliationMode) => void;
  categories: ReadonlyArray<Category>;
  locale: string;
  timeZone: string;
  editable: boolean;
  onCancel: () => void;
  onHistory: () => void;
  onDelete: (transaction: Transaction) => void;
  selectedId: Transaction["id"];
}>;
const captureLabels: Readonly<Record<CaptureSources[number]["kinds"][number], string>> = {
  manual: "Registro manual",
  "notification-email": "Correo de notificación",
  "statement-line": "Línea de extracto",
};
const captureLabel = (sources: CaptureSources, id: Transaction["id"]): string => {
  const source = sources.find((capture) => capture.transactionId === id);
  return source === undefined || source.kinds.length === 0
    ? "Información de captura no disponible"
    : source.kinds.map((kind) => captureLabels[kind]).join(" · ");
};
const Original = ({
  transaction,
  categories,
  locale,
  timeZone,
  number,
  sources,
}: Pick<Props, "categories" | "locale" | "timeZone"> &
  Readonly<{ transaction: Transaction; number: number; sources: CaptureSources }>): JSX.Element => {
  const row = presentTransactionRows({
    transactions: [transaction],
    categories,
    locale,
    timeZone,
    counterpartyFallback: "Contraparte no identificada",
  })[0];
  return (
    <section aria-label={`Original ${number}`} className="border-b border-border py-4">
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="font-semibold break-words">{row?.counterpartyLabel}</h3>
        <p className="font-semibold tabular-nums">
          {transaction.direction === "outflow" ? "−" : "+"}
          {formatMoneyWithCode({ money: transaction.money, locale })}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        {row?.transactionTypeLabel} · {row?.categoryLabel} · {row?.dateLabel}
      </p>
      <p className="text-sm text-muted-foreground">{captureLabel(sources, transaction.id)}</p>
      <p className="mt-2 text-sm break-words">
        {Option.getOrElse(transaction.notes, () => "Sin notas")}
      </p>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer rounded-sm py-3 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          Ver datos del original {number}
        </summary>
        <dl className="grid gap-2 py-2">
          <dt className="text-muted-foreground">Referencia</dt>
          <dd className="break-all">{transaction.id}</dd>
          <dt className="text-muted-foreground">Zona horaria</dt>
          <dd>{timeZone}</dd>
        </dl>
      </details>
    </section>
  );
};
const feedback = {
  review: [
    "Volverán a contar por separado",
    "Ambos originales aparecerán en el historial. Los totales del Panel y de Presupuestos pueden cambiar según sus fechas y categorías. Ninguno se elimina.",
  ],
  saving: ["Desvinculando transacciones…", "Espera la confirmación antes de continuar."],
  rejected: [
    "No se pudo desvincular",
    "La solicitud fue rechazada o el vínculo cambió. Actualiza el estado antes de continuar.",
  ],
  uncertain: [
    "No pudimos confirmar el resultado",
    "La solicitud pudo haberse completado. Actualiza el estado antes de realizar otra acción.",
  ],
  recovering: [
    "Consultando el estado del vínculo…",
    "No se repetirá la solicitud de desvinculación.",
  ],
  success: [
    "Se desvincularon las transacciones",
    "Los dos originales se conservaron y ahora aparecen por separado. Actualiza el historial para ver sus totales.",
  ],
  separate: [
    "El vínculo ya no está activo",
    "La transacción consultada aparece por separado. Actualiza el historial para revisar los registros actuales.",
  ],
  missing: [
    "La transacción ya no está disponible",
    "Actualiza el historial para revisar los registros actuales.",
  ],
} as const;
const useReconciliationActions = (
  props: Props
): Readonly<{ recover: () => void; confirm: () => void }> => {
  const [command] = useState(() => makeCommand(props.apiClient));
  const submit = useAtomSet(command);
  const admission = useRef(false);
  const { mode } = props;
  const recover = (): void => {
    if (admission.current) return;
    admission.current = true;
    props.onMode({ ...mode, status: "recovering" });
    submit({
      kind: "recover",
      id: props.selectedId,
      completed: (data) => {
        admission.current = false;
        props.onMode(
          data.reconciliation.kind === "linked"
            ? { ...mode, pair: data.reconciliation, sources: data.sources, status: "review" }
            : { ...mode, status: "separate", original: data }
        );
      },
      missing: () => {
        admission.current = false;
        props.onMode({ ...mode, status: "missing" });
      },
      failed: () => {
        admission.current = false;
        props.onMode({ ...mode, status: "uncertain" });
      },
    });
  };
  const confirm = (): void => {
    if (admission.current || mode.status !== "review" || !props.editable) return;
    admission.current = true;
    props.onMode({ ...mode, status: "saving" });
    submit({
      kind: "unlink",
      pair: mode.pair,
      completed: (pair) => {
        admission.current = false;
        props.onMode({ ...mode, pair, status: "success" });
      },
      failed: (status) => {
        admission.current = false;
        props.onMode({ ...mode, status });
      },
    });
  };
  return { recover, confirm };
};
const busyStatus = (status: ReconciliationMode["status"]): boolean =>
  status === "saving" || status === "recovering";
const ReconciliationActions = (
  props: Props & Readonly<{ recover: () => void; confirm: () => void }>
): JSX.Element => {
  const { mode } = props;
  if (mode.status === "review") {
    return (
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" onClick={props.onCancel}>
          Cancelar
        </Button>
        <Button disabled={!props.editable} onClick={props.confirm}>
          Desvincular
        </Button>
      </div>
    );
  }
  if (mode.status === "success" || mode.status === "separate") return <SuccessActions {...props} />;
  if (mode.status === "missing") {
    return (
      <Button variant="outline" onClick={props.onHistory}>
        Ver en el historial
      </Button>
    );
  }
  const busy = busyStatus(mode.status);
  return (
    <Button variant="outline" disabled={busy} onClick={props.recover}>
      {busy ? feedback[mode.status][0] : "Actualizar estado"}
    </Button>
  );
};
const SuccessActions = (props: Props): JSX.Element => {
  const original =
    props.mode.status === "separate"
      ? props.mode.original
      : [props.mode.pair.firstTransaction, props.mode.pair.secondTransaction].find(
          (transaction) => transaction.id === props.selectedId
        );
  return (
    <div className="flex flex-wrap gap-3">
      <Button variant="outline" onClick={props.onHistory}>
        Ver en el historial
      </Button>
      {props.mode.deleting && original !== undefined ? (
        <Button disabled={!props.editable} onClick={() => props.onDelete(original)}>
          Continuar eliminación
        </Button>
      ) : null}
    </div>
  );
};
const feedbackVariant = (
  status: ReconciliationMode["status"]
): "warning" | "success" | "information" | "destructive" => {
  if (status === "rejected") return "destructive";
  if (status === "review") return "warning";
  return status === "success" ? "success" : "information";
};
export const TransactionReconciliation = (props: Props): JSX.Element => {
  const actions = useReconciliationActions(props);
  const { mode } = props;
  const [title, description] = feedback[mode.status];
  return (
    <section
      aria-label="Revisar vínculo"
      data-transaction-slot="transaction-reconciliation"
      className="flex flex-col gap-4"
    >
      <p className="text-sm text-muted-foreground">
        {mode.deleting
          ? "Para continuar con la eliminación, revisa los dos originales."
          : "Estos dos registros cuentan como una sola transacción mientras están vinculados."}
      </p>
      <div>
        <Original
          {...props}
          sources={mode.sources}
          transaction={mode.pair.firstTransaction}
          number={1}
        />
        <Original
          {...props}
          sources={mode.sources}
          transaction={mode.pair.secondTransaction}
          number={2}
        />
      </div>
      <Alert
        role={mode.status === "review" ? "note" : "status"}
        variant={feedbackVariant(mode.status)}
      >
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
      </Alert>
      <ReconciliationActions {...props} {...actions} />
    </section>
  );
};
