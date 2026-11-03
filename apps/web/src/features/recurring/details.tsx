import { browserCrypto } from "@/browser/crypto";
import { Link } from "@tanstack/react-router";
import { BigDecimal, Effect, Option, Schema } from "effect";
import { type FormEvent, type JSX, useState } from "react";
import { RecurringCommand } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { DeferredDisclosure, Disclosure } from "@/ui/components/disclosure";
import { ChoiceField, DefaultChoiceField, RecurringDateField } from "./fields";
import { TransactionPicker } from "./transactions";
import { PaymentCapture } from "./payment-capture";
import {
  associateTransaction,
  associationBlocked,
  defaultReplacement,
  manualMarks,
  replacementOptions,
  settlementOptions,
} from "./payment-association";
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
      <FulfillmentHistory item={item} save={save} disabled={disabled} />
      {manualMarks(item).length > 1 ? (
        <p className="text-sm text-muted-foreground">
          Hay varias marcas manuales. Antes de crear o vincular transacciones, revierte las marcas
          manuales de esta fecha y luego registra cada pago por separado. Revertir solo cambia el
          seguimiento; no elimina transacciones.
        </p>
      ) : null}
      <LinkTransaction item={item} save={save} disabled={disabled} />
      <PaymentCapture {...props} />
      <PaymentForm {...props} />
      <OccurrenceEditor {...props} />
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
}: Pick<Props, "item" | "save" | "disabled">): JSX.Element => (
  <div className="grid gap-3">
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

const OccurrenceEditor = ({ item, save, categories, disabled }: Props): JSX.Element => {
  const [scope, setScope] = useState<"once" | "forward">("once");
  return (
    <>
      <Disclosure title="Editar recurrente">
        <div className="mt-4 flex gap-2">
          <Button
            contentLayout="wrap"
            focusAppearance="subtle"
            variant="outline"
            aria-pressed={scope === "once"}
            onClick={() => setScope("once")}
          >
            Solo esta vez
          </Button>
          <Button
            contentLayout="wrap"
            focusAppearance="subtle"
            variant="outline"
            aria-pressed={scope === "forward"}
            onClick={() => setScope("forward")}
          >
            Esta y próximas
          </Button>
        </div>
        <PlanForm
          initial={{ ...item.plan, firstDate: item.expectedDate }}
          categories={categories}
          disabled={disabled || (scope === "once" && item.fulfillments.length > 0)}
          onSubmit={(plan) =>
            save({ kind: "edit", planId: item.planId, date: item.date, scope, plan })
          }
        />
      </Disclosure>
    </>
  );
};

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

const LinkTransaction = ({
  item,
  save,
  disabled,
}: Pick<Props, "item" | "save" | "disabled">): JSX.Element => {
  const [replaces, setReplaces] = useState(() => defaultReplacement(item));
  const [settled, setSettled] = useState(false);
  return (
    <DeferredDisclosure title="Vincular transacción existente">
      <p className="my-3 text-sm text-muted-foreground">
        Vincula una transacción que ya está en tu historial. No crea otra ni suma el gasto de nuevo.
        Si ya marcaste este pago manualmente, elige la marca que reemplaza para no contar dos veces
        el seguimiento.
      </p>
      <LinkFields
        item={item}
        disabled={disabled}
        replaces={replaces}
        setReplaces={setReplaces}
        settled={settled}
        setSettled={setSettled}
      />
      <TransactionPicker
        disabled={disabled || associationBlocked({ item, replaces })}
        choose={(transaction) =>
          save(associateTransaction({ item, transaction, replaces, settled }))
        }
      />
    </DeferredDisclosure>
  );
};

const formText = (form: FormData, key: string): string => {
  const entry = form.get(key);
  return typeof entry === "string" ? entry : "";
};

const LinkFields = ({
  item,
  disabled,
  replaces,
  setReplaces,
  settled,
  setSettled,
}: Pick<Props, "item" | "disabled"> &
  Readonly<{
    replaces: string;
    setReplaces: (value: string) => void;
    settled: boolean;
    setSettled: (value: boolean) => void;
  }>): JSX.Element => (
  <fieldset disabled={disabled} className="grid gap-3 py-3">
    <Field label="Registro manual que reemplaza" name="linked-replaces">
      <ChoiceField
        name="linked-replaces"
        label="Registro manual que reemplaza"
        value={replaces}
        onChange={setReplaces}
        options={replacementOptions(item)}
      />
    </Field>
    <Field label="Estado de la transacción vinculada" name="linked-settlement">
      <ChoiceField
        name="linked-settlement"
        label="Estado de la transacción vinculada"
        value={settled ? "settled" : "partial"}
        onChange={(value) => setSettled(value === "settled")}
        options={settlementOptions}
      />
    </Field>
  </fieldset>
);
