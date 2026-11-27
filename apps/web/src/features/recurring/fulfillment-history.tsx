import { Link, useRouter } from "@tanstack/react-router";
import { DateTime, Option } from "effect";
import { type JSX, type Ref, useRef, useState } from "react";
import { cn } from "@/ui/class-names";
import { Button } from "@/ui/components/button";
import { buttonVariants } from "@/ui/components/button-variants";
import {
  type Category,
  type Occurrence,
  type Save,
  type Workspace,
  dayLabel,
  money,
} from "./model";

type Mark = Occurrence["fulfillments"][number];

type Transaction = Workspace["linkedTransactions"][number];

type LinkedLabels = Readonly<{
  unlink: string;
  accessibleUnlink: string;
  accessibleView: string;
  target: string;
}>;

type RecordFacts = Readonly<{
  mark: Mark;
  transaction: Option.Option<Transaction>;
  amount: string;
}>;

type Props = Readonly<{
  item: Occurrence;
  month: Workspace["month"];
  transactions: Workspace["linkedTransactions"];
  invalidMarks: ReadonlyArray<Mark>;
  categories: ReadonlyArray<Category>;
  save: Save;
  disabled: boolean;
}>;

const recordFacts = ({ item, invalidMarks, transactions }: Props): ReadonlyArray<RecordFacts> => {
  const byId = new Map<string, Transaction>(transactions.map((entry) => [entry.id, entry]));

  return [...item.fulfillments, ...invalidMarks].map((mark) => {
    const transaction = Option.flatMap(Option.fromUndefinedOr(mark.transactionId), (id) =>
      Option.fromUndefinedOr(byId.get(id))
    );

    return {
      mark,
      transaction,
      amount: money(
        Option.match(transaction, {
          onNone: () => mark.money,
          onSome: (entry) => entry.money,
        })
      ),
    };
  });
};

const linkedAmountCounts = (records: ReadonlyArray<RecordFacts>): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();

  for (const { mark, amount } of records) {
    if (mark.transactionId !== undefined) counts.set(amount, (counts.get(amount) ?? 0) + 1);
  }

  return counts;
};

const linkedLabels = (
  { mark, transaction, amount }: RecordFacts,
  timeZone: string,
  position: Option.Option<number>
): LinkedLabels => {
  const date = Option.match(transaction, {
    onNone: () => dayLabel(mark.actualDate),
    onSome: (entry) =>
      DateTime.format(entry.occurredAt, { locale: "es-CO", timeZone, dateStyle: "long" }),
  });

  const counterparty = Option.flatMap(transaction, (entry) => entry.counterparty);

  const name = Option.match(counterparty, {
    onNone: () => "",
    onSome: (value) => ` · ${value}`,
  });

  const record = Option.match(position, {
    onNone: () => "",
    onSome: (value) => ` · Registro ${value}`,
  });

  const unlink = `Desvincular ${amount}${record}`;

  return {
    unlink,
    accessibleUnlink: `${unlink} · ${date}${name}`,
    accessibleView: `Ver transacción · ${amount} · ${date}${name}${record}`,
    target: `la transacción de ${amount} del ${date}${name}${record}`,
  };
};

export const FulfillmentHistory = ({
  heading,
  ...props
}: Props & Readonly<{ heading: Ref<HTMLHeadingElement> }>): JSX.Element => {
  const records = recordFacts(props);
  const counts = linkedAmountCounts(records);

  return (
    <section className="grid gap-3" aria-label="Seguimiento de la ocurrencia">
      {records.length > 0 ? (
        <h3 ref={heading} tabIndex={-1} className="font-semibold">
          Seguimiento de esta fecha
        </h3>
      ) : null}
      {records.map((record, index) => (
        <FulfillmentRecord
          key={record.mark.id}
          {...props}
          record={record}
          position={(counts.get(record.amount) ?? 0) > 1 ? Option.some(index + 1) : Option.none()}
        />
      ))}
    </section>
  );
};

const FulfillmentRecord = ({
  record,
  position,
  ...props
}: Props & Readonly<{ record: RecordFacts; position: Option.Option<number> }>): JSX.Element => {
  const { mark, transaction, amount } = record;

  const name = Option.match(transaction, {
    onNone: () => "Transacción no disponible",
    onSome: (entry) => Option.getOrElse(entry.counterparty, () => "Contraparte no identificada"),
  });

  const labels =
    mark.transactionId === undefined
      ? Option.none()
      : Option.some(linkedLabels(record, props.item.plan.timeZone, position));

  return (
    <article
      data-recurring-slot="fulfillment"
      aria-label={
        mark.transactionId === undefined ? "Marca manual" : `Transacción vinculada: ${name}`
      }
    >
      {mark.transactionId === undefined ? (
        <ManualMark mark={mark} amount={amount} />
      ) : (
        <LinkedFacts {...props} mark={mark} transaction={transaction} name={name} amount={amount} />
      )}
      <FulfillmentAction
        mark={mark}
        labels={labels}
        save={props.save}
        disabled={props.disabled}
        viewTransaction={
          Option.isSome(transaction) && Option.isSome(labels) && !props.disabled
            ? Option.some(
                <ViewTransaction
                  transactionId={transaction.value.id}
                  month={props.month}
                  label={labels.value.accessibleView}
                />
              )
            : Option.none()
        }
      />
    </article>
  );
};

const ManualMark = ({ mark, amount }: Readonly<{ mark: Mark; amount: string }>): JSX.Element => (
  <>
    <p>
      {mark.actualDate} · {amount} · Sin transacción vinculada
    </p>
    <p className="text-sm text-muted-foreground">
      Esta marca no modifica tus gastos o presupuestos. Si la transacción ya está en tu historial,
      vincúlala; si falta, créala y vincúlala.
    </p>
  </>
);

const LinkedFacts = ({
  mark,
  transaction,
  name,
  amount,
  item,
  categories,
  invalidMarks,
}: Pick<Props, "item" | "categories" | "invalidMarks"> &
  Readonly<{
    mark: Mark;
    transaction: Option.Option<Transaction>;
    name: string;
    amount: string;
  }>): JSX.Element => {
  const invalid = invalidMarks.some((entry) => entry.id === mark.id);

  return (
    <>
      <div data-recurring-slot="fulfillment-identity">
        <h3>{name}</h3>
        <strong className="tabular-nums">
          {Option.match(transaction, {
            onNone: () => amount,
            onSome: (entry) => `${entry.direction === "inflow" ? "+" : "−"}${amount}`,
          })}
        </strong>
      </div>
      {Option.match(transaction, {
        onNone: () => <p className="text-sm text-muted-foreground">{mark.actualDate}</p>,
        onSome: (entry) => (
          <TransactionFacts
            transaction={entry}
            timeZone={item.plan.timeZone}
            categories={categories}
          />
        ),
      })}
      {invalid || Option.isNone(transaction) ? (
        <p className="text-sm text-muted-foreground">
          {Option.isNone(transaction)
            ? "No encontramos esta transacción o ya no tienes acceso a ella."
            : "La transacción cambió y este vínculo requiere revisión."}{" "}
          Este registro no se incluye como completado. Puedes retirar la asociación.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Desvincular solo retira el seguimiento de esta fecha; no elimina la transacción.
      </p>
    </>
  );
};

const TransactionFacts = ({
  transaction,
  timeZone,
  categories,
}: Readonly<{
  transaction: Transaction;
  timeZone: string;
  categories: ReadonlyArray<Category>;
}>): JSX.Element => {
  const category = categories.find((entry) => entry.id === transaction.categoryId);

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {DateTime.format(transaction.occurredAt, {
          locale: "es-CO",
          timeZone,
          day: "numeric",
          month: "short",
          year: "numeric",
        })}
        {" · "}
        {transaction.direction === "inflow" ? "Entrada" : "Salida"}
      </p>
      <dl data-recurring-slot="fulfillment-facts">
        {category === undefined ? null : (
          <div>
            <dt>Categoría</dt>
            <dd>{category.label}</dd>
          </div>
        )}
        {Option.isSome(transaction.notes) ? (
          <div>
            <dt>Nota</dt>
            <dd>{transaction.notes.value}</dd>
          </div>
        ) : null}
      </dl>
    </>
  );
};

const ViewTransaction = ({
  transactionId,
  month,
  label,
}: Readonly<{
  transactionId: Transaction["id"];
  month: Props["month"];
  label: string;
}>): JSX.Element => {
  const { sessionBinding } = useRouter().options.context;

  return (
    <Link
      to="/app/transactions"
      search={{ transaction: transactionId }}
      state={(previous) => ({
        ...previous,
        recurringTransactionOrigin: { binding: sessionBinding, month, transactionId },
      })}
      data-slot="button"
      className={cn(buttonVariants({ variant: "outline", contentLayout: "wrap" }))}
      aria-label={label}
    >
      Ver transacción
    </Link>
  );
};

const FulfillmentAction = ({
  mark,
  labels,
  save,
  disabled,
  viewTransaction,
}: Pick<Props, "save" | "disabled"> &
  Readonly<{
    mark: Mark;
    labels: Option.Option<LinkedLabels>;
    viewTransaction: Option.Option<JSX.Element>;
  }>): JSX.Element => {
  const [reviewing, setReviewing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {Option.getOrNull(viewTransaction)}
        <Button
          ref={trigger}
          className="justify-self-start"
          contentLayout="wrap"
          variant="destructive"
          disabled={disabled}
          aria-label={Option.getOrUndefined(Option.map(labels, (label) => label.accessibleUnlink))}
          aria-expanded={Option.isSome(labels) ? reviewing : undefined}
          onClick={() =>
            Option.isSome(labels)
              ? setReviewing(true)
              : save({ kind: "reverse", fulfillmentId: mark.id })
          }
        >
          {Option.match(labels, { onNone: () => "Revertir", onSome: (label) => label.unlink })}
        </Button>
      </div>
      {reviewing && Option.isSome(labels) ? (
        <UnlinkConfirmation
          target={labels.value.target}
          disabled={disabled}
          onCancel={() => {
            setReviewing(false);
            trigger.current?.focus();
          }}
          onConfirm={() => save({ kind: "reverse", fulfillmentId: mark.id })}
        />
      ) : null}
    </div>
  );
};

const UnlinkConfirmation = ({
  target,
  disabled,
  onCancel,
  onConfirm,
}: Readonly<{
  target: string;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}>): JSX.Element => (
  <fieldset
    className="grid gap-3 border-t pt-3"
    aria-label={`Confirmar desvinculación de ${target}`}
  >
    <legend className="pt-3">¿Desvincular {target}?</legend>
    <p className="text-sm text-muted-foreground">
      Se retirará este registro del seguimiento de esta fecha. La transacción no se elimina de tu
      historial.
    </p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={disabled} onClick={onCancel}>
        Volver
      </Button>
      <Button
        contentLayout="wrap"
        variant="destructive"
        disabled={disabled}
        aria-label={`Confirmar desvinculación de ${target}`}
        onClick={onConfirm}
      >
        Confirmar desvinculación
      </Button>
    </div>
  </fieldset>
);
