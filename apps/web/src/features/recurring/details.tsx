import { browserCrypto } from "@/browser/crypto";
import { BigDecimal, DateTime, Effect, Option, Schema } from "effect";
import { type FormEvent, type JSX, useState } from "react";
import { RecurringCommand } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { Disclosure } from "@/ui/components/disclosure";
import { ChoiceField, DefaultChoiceField, RecurringDateField } from "./fields";
import { TransactionPicker } from "./transactions";
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
        <h3 className="font-medium">Registrar pago o ingreso</h3>
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
          Registrar
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
      variant="outline"
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
    <div className="flex flex-wrap justify-center gap-2">
      {(
        [
          ["pause", "Pausar"],
          ["resume", "Reanudar"],
        ] as const
      ).map(([action, label]) => (
        <Button
          contentLayout="wrap"
          focusAppearance="subtle"
          key={action}
          variant="outline"
          disabled={disabled}
          onClick={() => save({ kind: "lifecycle", planId: item.planId, date: today, action })}
        >
          {label}
        </Button>
      ))}
    </div>
    <Disclosure title="Dejar de seguir">
      <p className="my-3 text-sm text-muted-foreground">
        Deja de generar expectativas futuras y conserva el historial. No cancela el servicio ni
        detiene un pago bancario.
      </p>
      <Button
        contentLayout="wrap"
        focusAppearance="subtle"
        variant="outline"
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
    <div className="grid gap-5 overflow-y-auto p-5">
      <p>
        {item.expectedDate} · {statuses[item.status]}
      </p>
      <p className="text-lg font-medium">{expectedAmount(item)}</p>
      <p>
        Registrado: {money(item.completed)}
        {item.remaining === undefined ? "" : ` · Restante: ${money(item.remaining)}`}
      </p>
      {item.fulfillments.map((mark) => (
        <div key={mark.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            {mark.actualDate} · {money(mark.money)} ·{" "}
            {mark.transactionId === undefined ? "Registro manual" : "Transacción vinculada"}
          </span>
          <Button
            contentLayout="wrap"
            focusAppearance="subtle"
            variant="ghost"
            disabled={disabled}
            onClick={() => save({ kind: "reverse", fulfillmentId: mark.id })}
          >
            Revertir
          </Button>
        </div>
      ))}
      <PaymentForm {...props} />
      <LinkTransaction item={item} save={save} disabled={disabled} />
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

const manualOptions = (
  item: Occurrence
): ReadonlyArray<Readonly<{ value: string; label: string }>> => [
  { value: "", label: "Ninguno" },
  ...item.fulfillments
    .filter((mark) => mark.transactionId === undefined)
    .map((mark) => ({ value: mark.id, label: `${mark.actualDate} · ${money(mark.money)}` })),
];
const settlementOptions = [
  { value: "partial", label: "Parcial" },
  { value: "settled", label: "Pago o ingreso completo" },
];
const AssociationFields = ({ item }: Pick<Props, "item">): JSX.Element => (
  <>
    <Field label="Reemplazar registro manual" name="replaces">
      <DefaultChoiceField
        name="replaces"
        label="Reemplazar registro manual"
        initial=""
        options={manualOptions(item)}
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
        id: Effect.runSync(browserCrypto.randomUUIDv4.pipe(Effect.orDie)),
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
  const [replaces, setReplaces] = useState("");
  const [settled, setSettled] = useState(false);
  return (
    <Disclosure title="Vincular transacción existente">
      <LinkFields
        item={item}
        disabled={disabled}
        replaces={replaces}
        setReplaces={setReplaces}
        settled={settled}
        setSettled={setSettled}
      />
      <TransactionPicker
        disabled={disabled}
        choose={(transaction) =>
          save({
            kind: "fulfill",
            ...(replaces === "" ? {} : { replaces }),
            fulfillment: {
              id: Effect.runSync(browserCrypto.randomUUIDv4.pipe(Effect.orDie)),
              planId: item.planId,
              date: item.date,
              actualDate: DateTime.formatIsoDate(
                DateTime.makeZonedUnsafe(transaction.occurredAt, { timeZone: item.plan.timeZone })
              ),
              money: transaction.money,
              settled,
              transactionId: transaction.id,
            },
          })
        }
      />
    </Disclosure>
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
        options={manualOptions(item)}
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
