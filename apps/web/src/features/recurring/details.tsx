import { browserCrypto } from "@/browser/crypto";
import { BigDecimal, DateTime, Effect, Option, Schema } from "effect";
import { type FormEvent, type JSX, useState } from "react";
import { RecurringCommand } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { NativeSelect } from "@/ui/components/native-select";
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
          <Input
            id="recurring-actualDate"
            name="actualDate"
            type="date"
            required
            defaultValue={today}
          />
        </Field>
        <AssociationFields item={item} />
        <p className="text-xs text-muted-foreground">
          Este registro solo actualiza el seguimiento. No crea una transacción. Para vincular un
          movimiento posterior, reemplaza el registro manual correspondiente.
        </p>
        {invalid ? <p role="alert">Revisa el importe y la fecha.</p> : null}
        <Button type="submit">Registrar parcial</Button>
      </fieldset>
    </form>
  );
};
const TrackingActions = ({ item, save, disabled, today }: Props): JSX.Element => (
  <div className="grid gap-3 border-t pt-4">
    <Button
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
    <div className="flex flex-wrap gap-2">
      {(
        [
          ["pause", "Pausar"],
          ["resume", "Reanudar"],
        ] as const
      ).map(([action, label]) => (
        <Button
          key={action}
          variant="outline"
          disabled={disabled}
          onClick={() => save({ kind: "lifecycle", planId: item.planId, date: today, action })}
        >
          {label}
        </Button>
      ))}
    </div>
    <details>
      <summary className="cursor-pointer text-sm">Dejar de seguir</summary>
      <p className="my-3 text-sm text-muted-foreground">
        Deja de generar expectativas futuras y conserva el historial. No cancela el servicio ni
        detiene un pago bancario.
      </p>
      <Button
        variant="outline"
        disabled={disabled}
        onClick={() =>
          save({ kind: "lifecycle", planId: item.planId, date: today, action: "stop" })
        }
      >
        Confirmar dejar de seguir
      </Button>
    </details>
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

const AssociationFields = ({ item }: Pick<Props, "item">): JSX.Element => (
  <>
    <Field label="Reemplazar registro manual" name="replaces">
      <NativeSelect id="recurring-replaces" name="replaces" size="default">
        <option value="">Ninguno</option>
        {item.fulfillments
          .filter((mark) => mark.transactionId === undefined)
          .map((mark) => (
            <option key={mark.id} value={mark.id}>
              {mark.actualDate} · {money(mark.money)}
            </option>
          ))}
      </NativeSelect>
    </Field>
    <Field label="Estado del importe real" name="settlement">
      <NativeSelect id="recurring-settlement" name="settlement" size="default">
        <option value="partial">Parcial</option>
        <option value="settled">Pago o ingreso completo</option>
      </NativeSelect>
    </Field>
  </>
);

const OccurrenceEditor = ({ item, save, categories, disabled }: Props): JSX.Element => {
  const [scope, setScope] = useState<"once" | "forward">("once");
  return (
    <>
      <details>
        <summary className="cursor-pointer font-medium">Editar recurrente</summary>
        <div className="mt-4 flex gap-2">
          <Button
            variant="outline"
            aria-pressed={scope === "once"}
            onClick={() => setScope("once")}
          >
            Solo esta vez
          </Button>
          <Button
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
      </details>
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
    <details>
      <summary className="cursor-pointer font-medium">Vincular transacción existente</summary>
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
    </details>
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
  <div className="grid gap-3 py-3">
    <Field label="Registro manual que reemplaza" name="linked-replaces">
      <NativeSelect
        id="recurring-linked-replaces"
        size="default"
        value={replaces}
        onChange={(event) => setReplaces(event.target.value)}
        disabled={disabled}
      >
        <option value="">Ninguno</option>
        {item.fulfillments
          .filter((mark) => mark.transactionId === undefined)
          .map((mark) => (
            <option key={mark.id} value={mark.id}>
              {mark.actualDate} · {money(mark.money)}
            </option>
          ))}
      </NativeSelect>
    </Field>
    <Field label="Estado de la transacción vinculada" name="linked-settlement">
      <NativeSelect
        id="recurring-linked-settlement"
        size="default"
        value={settled ? "settled" : "partial"}
        onChange={(event) => setSettled(event.target.value === "settled")}
        disabled={disabled}
      >
        <option value="partial">Parcial</option>
        <option value="settled">Pago o ingreso completo</option>
      </NativeSelect>
    </Field>
  </div>
);
