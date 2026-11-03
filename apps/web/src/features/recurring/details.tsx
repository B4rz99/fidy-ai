import { browserCrypto } from "@/browser/crypto";
import { Link } from "@tanstack/react-router";
import { BigDecimal, Effect, Option, Schema } from "effect";
import { type FormEvent, type JSX, type Ref, useId, useRef, useState } from "react";
import { RecurringCommand } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { Disclosure } from "@/ui/components/disclosure";
import { DefaultChoiceField, RecurringDateField } from "./fields";
import { PaymentCapture } from "./payment-capture";
import { manualMarks, replacementOptions, settlementOptions } from "./payment-association";
import { PlanForm } from "./plan-form";
import { Field } from "./form-fields";
import {
  type Category,
  type Occurrence,
  type Save,
  expectedAmount,
  money,
  statuses,
} from "./model";

type Props = Readonly<{
  item: Occurrence;
  categories: ReadonlyArray<Category>;
  save: Save;
  disabled: boolean;
  today: string;
  link: () => void;
}>;
const PaymentForm = ({ item, save, disabled, today }: Props): JSX.Element => {
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const command = paymentCommand(new FormData(event.currentTarget), item);
    setInvalid(Option.isNone(command));
    if (Option.isSome(command)) save(command.value.edit);
  };
  return (
    <form onSubmit={submit} className="grid gap-4 border-t pt-4">
      <fieldset disabled={disabled} className="grid gap-4">
        <h3 className="font-medium">Marcar solo en recurrentes</h3>
        <p className="text-sm text-muted-foreground">
          Actualiza únicamente el seguimiento de este recurrente. No crea una transacción ni
          modifica tus gastos o presupuestos.
        </p>
        <Field label="Importe real" name="actualAmount">
          <Input
            id="recurring-actualAmount"
            name="amount"
            required
            inputMode="decimal"
            defaultValue={
              item.remaining === undefined ? "" : BigDecimal.format(item.remaining.amount)
            }
          />
        </Field>
        <Field label="Fecha real" name="actualDate">
          <RecurringDateField
            name="actualDate"
            label="Fecha real"
            initial={today}
            timeZone={item.plan.timeZone}
            required
          />
        </Field>
        <AssociationFields item={item} />
        {invalid ? <p role="alert">Revisa el importe y la fecha.</p> : null}
        <Button contentLayout="wrap" focusAppearance="subtle" type="submit">
          Marcar solo en recurrentes
        </Button>
      </fieldset>
    </form>
  );
};
const TrackingActions = ({ item, save, disabled, today }: Props): JSX.Element => (
  <div className="grid gap-3 border-t pt-4">
    <Button
      contentLayout="wrap"
      focusAppearance="subtle"
      variant={item.status === "skipped" ? "outline" : "destructive"}
      disabled={disabled || item.fulfillments.length > 0}
      onClick={() =>
        save({
          kind: "skip",
          planId: item.planId,
          date: item.date,
          skipped: item.status !== "skipped",
        })
      }
    >
      {item.status === "skipped" ? "Volver a incluir" : "Omitir esta vez"}
    </Button>
    <Disclosure title="Dejar de seguir">
      <p className="my-3 text-sm text-muted-foreground">
        Deja de generar expectativas futuras y conserva el historial. No cancela el servicio ni
        detiene un pago bancario.
      </p>
      <Button
        contentLayout="wrap"
        focusAppearance="subtle"
        variant="destructive"
        disabled={disabled}
        onClick={() =>
          save({ kind: "lifecycle", planId: item.planId, date: today, action: "stop" })
        }
      >
        Confirmar dejar de seguir
      </Button>
    </Disclosure>
  </div>
);
export const OccurrenceDetails = (props: Props): JSX.Element => {
  const { item, save, disabled } = props;
  const trackingHeading = useRef<HTMLHeadingElement>(null);
  return (
    <div data-recurring-slot="occurrence-detail" className="grid gap-5">
      <p>
        {item.expectedDate} · {statuses[item.status]}
      </p>
      <p className="text-lg font-medium">{expectedAmount(item)}</p>
      <p>
        Completado en recurrentes: {money(item.completed)}
        {item.remaining === undefined ? "" : ` · Restante: ${money(item.remaining)}`}
      </p>
      <FulfillmentHistory item={item} save={save} disabled={disabled} heading={trackingHeading} />
      {manualMarks(item).length > 1 ? (
        <p className="text-sm text-muted-foreground">
          Hay varias marcas manuales. Antes de crear o vincular transacciones, revierte las marcas
          manuales de esta fecha y luego registra cada pago por separado. Revertir solo cambia el
          seguimiento; no elimina transacciones.
        </p>
      ) : null}
      <Button variant="outline" disabled={disabled} onClick={props.link}>
        Vincular transacción existente
      </Button>
      <PaymentCapture {...props} />
      <PaymentForm {...props} />
      <OccurrenceEditor {...props} reviewTracking={() => trackingHeading.current?.focus()} />
      {item.status === "completed" ? (
        <Button
          contentLayout="wrap"
          focusAppearance="subtle"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            save({
              kind: "edit",
              planId: item.planId,
              date: item.date,
              scope: "forward",
              plan: {
                ...item.plan,
                firstDate: item.expectedDate,
                money: item.completed,
                amountMode: "estimated",
              },
            })
          }
        >
          Usar este valor para los próximos
        </Button>
      ) : null}
      <TrackingActions {...props} />
    </div>
  );
};

const FulfillmentHistory = ({
  item,
  save,
  disabled,
  heading,
}: Pick<Props, "item" | "save" | "disabled"> &
  Readonly<{ heading: Ref<HTMLHeadingElement> }>): JSX.Element => (
  <div className="grid gap-3">
    {item.fulfillments.length > 0 ? (
      <h3 ref={heading} tabIndex={-1} className="font-medium">
        Seguimiento de esta fecha
      </h3>
    ) : null}
    {item.fulfillments.map((mark) => (
      <div key={mark.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          {mark.actualDate} · {money(mark.money)} ·{" "}
          {mark.transactionId === undefined ? "Sin transacción vinculada" : "Transacción vinculada"}
          {mark.transactionId === undefined ? (
            <span className="block text-muted-foreground">
              Esta marca no modifica tus gastos o presupuestos. Si la transacción ya está en tu
              historial, vincúlala; si falta, créala y vincúlala.
            </span>
          ) : (
            <span className="block text-muted-foreground">
              El vínculo usa la transacción de tu historial. Revertir solo retira el seguimiento; no
              elimina la transacción.{" "}
              <Link to="/app/transactions" className="underline">
                Ver transacciones
              </Link>
            </span>
          )}
        </span>
        <Button
          contentLayout="wrap"
          focusAppearance="subtle"
          variant="destructive"
          disabled={disabled}
          onClick={() => save({ kind: "reverse", fulfillmentId: mark.id })}
        >
          Revertir
        </Button>
      </div>
    ))}
  </div>
);

const AssociationFields = ({ item }: Pick<Props, "item">): JSX.Element => (
  <>
    <Field label="Reemplazar registro manual" name="replaces">
      <DefaultChoiceField
        name="replaces"
        label="Reemplazar registro manual"
        initial=""
        options={replacementOptions(item)}
      />
    </Field>
    <Field label="Estado del importe real" name="settlement">
      <DefaultChoiceField
        name="settlement"
        label="Estado del importe real"
        initial="partial"
        options={settlementOptions}
      />
    </Field>
  </>
);

const OccurrenceEditor = ({
  item,
  save,
  categories,
  disabled,
  reviewTracking,
}: Props & Readonly<{ reviewTracking: () => void }>): JSX.Element => {
  const [scope, setScope] = useState<"once" | "forward">("once");
  const descriptionId = useId();
  const hasTracking = item.fulfillments.length > 0;
  return (
    <>
      <Disclosure title="Editar recurrente">
        <div className="mt-4 flex gap-2">
          <Button
            contentLayout="wrap"
            focusAppearance="subtle"
            variant="outline"
            aria-pressed={scope === "once"}
            aria-describedby={`${descriptionId}-once`}
            onClick={() => setScope("once")}
          >
            Solo esta vez
          </Button>
          <Button
            contentLayout="wrap"
            focusAppearance="subtle"
            variant="outline"
            aria-pressed={scope === "forward"}
            aria-describedby={`${descriptionId}-forward`}
            onClick={() => setScope("forward")}
          >
            Esta y próximas
          </Button>
        </div>
        <ScopeGuidance
          scope={scope}
          descriptionId={descriptionId}
          hasTracking={hasTracking}
          reviewTracking={reviewTracking}
        />
        <PlanForm
          initial={{ ...item.plan, firstDate: item.expectedDate }}
          categories={categories}
          disabled={disabled || (scope === "once" && hasTracking)}
          onSubmit={(plan) =>
            save({ kind: "edit", planId: item.planId, date: item.date, scope, plan })
          }
        />
      </Disclosure>
    </>
  );
};

const ScopeGuidance = ({
  scope,
  descriptionId,
  hasTracking,
  reviewTracking,
}: Readonly<{
  scope: "once" | "forward";
  descriptionId: string;
  hasTracking: boolean;
  reviewTracking: () => void;
}>): JSX.Element => (
  <div className="my-4 grid gap-3 text-sm text-muted-foreground" aria-live="polite">
    <p id={`${descriptionId}-once`} hidden={scope !== "once"}>
      {hasTracking
        ? "Esta fecha ya tiene seguimiento registrado y no se puede editar solo esta vez. Revisa las transacciones vinculadas y las marcas manuales. Si el seguimiento es incorrecto, usa Revertir en cada registro de esta fecha antes de editarla. Esto solo retira el seguimiento: no elimina transacciones ni revierte pagos reales."
        : "Los cambios se aplican solo a esta fecha. Las próximas fechas conservan sus datos."}
    </p>
    <p id={`${descriptionId}-forward`} hidden={scope !== "forward"}>
      Los cambios se aplican al recurrente desde esta fecha en adelante. Las fechas con seguimiento
      conservan sus datos, incluida esta si ya tiene registros. Esta opción no corrige el
      seguimiento de una sola fecha.
    </p>
    {scope === "once" && hasTracking ? (
      <Button variant="outline" onClick={reviewTracking}>
        Revisar seguimiento
      </Button>
    ) : null}
  </div>
);

const paymentCommand = (form: FormData, item: Occurrence): Option.Option<RecurringCommand> => {
  const transactionId = formText(form, "transactionId").trim();
  const replaces = formText(form, "replaces");
  return Schema.decodeUnknownOption(Schema.toCodecJson(RecurringCommand))({
    expectedRevision: 0,
    edit: {
      kind: "fulfill",
      ...(replaces === "" ? {} : { replaces }),
      fulfillment: {
        id: Effect.runSync(browserCrypto.randomUUIDv4().pipe(Effect.orDie)),
        planId: item.planId,
        date: item.date,
        actualDate: form.get("actualDate"),
        settled: form.get("settlement") === "settled",
        money: { amount: form.get("amount"), currency: item.plan.currency },
        ...(transactionId === "" ? {} : { transactionId }),
      },
    },
  });
};

const formText = (form: FormData, key: string): string => {
  const entry = form.get(key);
  return typeof entry === "string" ? entry : "";
};
