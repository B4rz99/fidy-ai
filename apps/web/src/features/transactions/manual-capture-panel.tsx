import { type JSX, use } from "react";
import { Option } from "effect";
import { Button } from "@/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { TransactionCaptureRecovery } from "@/ui/components/transaction-capture-recovery";
import { formatMoneyWithCode } from "@/transport/money";
import { parseMoneyInput } from "@/transport/money-input";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import { ControlledTransactionCapture } from "./capture";
import {
  type CaptureHistoryVersion,
  type ManualCapture,
  ManualCaptureContext,
} from "./manual-capture-context";
import type { CaptureDraft } from "./capture-draft";
import { type Category, type CurrentUser } from "./presentation";

type Props = Readonly<{
  apiClient: FidyClient;
  categories: ReadonlyArray<Category>;
  currentUser: Pick<CurrentUser, "locale" | "timeZone">;
  version: CaptureHistoryVersion;
  editable: boolean;
  waiting: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onCreated: (transaction: CanonicalSuccess<"transactions.createTransaction">["data"]) => void;
}>;
const attemptFields = (
  draft: CaptureDraft,
  props: Props
): ReadonlyArray<Readonly<{ label: string; value: string }>> => [
  {
    label: "Monto",
    value: Option.match(parseMoneyInput({ text: draft.amount, currency: draft.currency }), {
      onNone: () => `${draft.amount} ${draft.currency}`,
      onSome: (money) => formatMoneyWithCode({ money, locale: props.currentUser.locale }),
    }),
  },
  { label: "Tipo", value: draft.direction === "inflow" ? "Ingreso" : "Gasto" },
  { label: "Fecha", value: draft.occurredOn.split("-").toReversed().join("-") },
  { label: "Contraparte", value: draft.counterparty || "Sin contraparte" },
  {
    label: "Categoría",
    value:
      props.categories.find((category) => category.id === draft.categoryId)?.label ??
      (draft.categoryId === "" ? "Asignar automáticamente" : "Categoría no disponible"),
  },
  { label: "Notas", value: draft.notes || "Sin notas" },
];
const PreviousAttempt = ({
  capture,
  props,
}: Readonly<{ capture: ManualCapture; props: Props }>): JSX.Element =>
  Option.match(capture.attempt, {
    onNone: () => <></>,
    onSome: (draft) => (
      <>
        <Alert variant="warning">
          <AlertTitle>Nuevo registro a partir del borrador</AlertTitle>
          <AlertDescription>
            El guardado del intento original sigue sin confirmar. Registrar creará una transacción
            nueva; si el primer intento se guardó, podría quedar duplicada.
          </AlertDescription>
        </Alert>
        <section aria-label="Datos del intento original">
          <dl className="flex flex-col gap-2">
            {attemptFields(draft, props).map((field) => (
              <div key={field.label}>
                <dt>{field.label}</dt>
                <dd className="whitespace-pre-wrap break-words">{field.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </>
    ),
  });
const ManualCaptureEditor = ({
  capture,
  props,
  close,
}: Readonly<{ capture: ManualCapture; props: Props; close: () => void }>): JSX.Element => (
  <>
    <PreviousAttempt capture={capture} props={props} />
    <ControlledTransactionCapture
      currency={Option.none()}
      initial={{}}
      direction={Option.none()}
      disabled={!props.editable}
      categories={props.categories}
      onCancel={Option.some(close)}
      apiClient={props.apiClient}
      timeZone={props.currentUser.timeZone}
      task={capture}
      newAttempt={Option.isSome(capture.attempt)}
      onCheckHistory={props.onRefresh}
      onInvalidate={props.onRefresh}
      onCreated={(transaction) => {
        props.onCreated(transaction);
        capture.clear();
        props.onClose();
      }}
    />
  </>
);
const CaptureContent = ({
  capture,
  props,
}: Readonly<{ capture: ManualCapture; props: Props }>): JSX.Element => {
  const uncertain = capture.uncertain;
  const checked =
    props.editable &&
    Option.exists(
      capture.check,
      (version) =>
        version.month === props.version.month && version.generation < props.version.generation
    );
  const close = (): void => {
    if (Option.isNone(capture.attempt)) capture.clear();
    props.onClose();
  };
  return (
    <section className="flex min-w-0 flex-col gap-6">
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          {uncertain ? "Borrador por revisar" : "Registrar transacción"}
        </h2>
        <Button
          size="sm"
          variant="ghost"
          disabled={capture.saving}
          onClick={close}
          aria-label="Cerrar registro"
        >
          ×
        </Button>
      </header>
      {uncertain ? (
        <TransactionCaptureRecovery
          fields={Option.match(capture.attempt, {
            onNone: () => [],
            onSome: (draft) => attemptFields(draft, props),
          })}
          checked={checked}
          waiting={props.waiting}
          onCheck={() => {
            capture.checkHistory(props.version);
            props.onRefresh();
          }}
          onResume={() => {
            if (checked) capture.resumeAfterInspection(props.version);
          }}
          onDiscard={() => {
            capture.clear();
            props.onClose();
          }}
          onHistory={props.onClose}
        />
      ) : (
        <ManualCaptureEditor capture={capture} props={props} close={close} />
      )}
    </section>
  );
};
export const ManualCapturePanel = (props: Props): JSX.Element =>
  Option.match(use(ManualCaptureContext), {
    onNone: () => <p role="alert">No pudimos abrir el borrador.</p>,
    onSome: (capture) => <CaptureContent capture={capture} props={props} />,
  });
