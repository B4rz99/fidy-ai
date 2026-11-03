import { Array, DateTime, Option } from "effect";
import { type JSX, type Ref, useRef, useState } from "react";
import { Button } from "@/ui/components/button";
import { type Category, type Occurrence, type Save, type Workspace, money } from "./model";

type Mark = Occurrence["fulfillments"][number];
type Transaction = Workspace["linkedTransactions"][number];
type Props = Readonly<{
  item: Occurrence;
  heading: Ref<HTMLHeadingElement>;
  transactions: Workspace["linkedTransactions"];
  invalidMarks: ReadonlyArray<Mark>;
  categories: ReadonlyArray<Category>;
  save: Save;
  disabled: boolean;
}>;
export const FulfillmentHistory = (props: Props): JSX.Element => (
  <section className="grid gap-3" aria-label="Seguimiento de la ocurrencia">
    {props.item.fulfillments.length + props.invalidMarks.length > 0 ? (
      <h3 ref={props.heading} tabIndex={-1} className="font-medium">
        Seguimiento de esta fecha
      </h3>
    ) : null}
    {[...props.item.fulfillments, ...props.invalidMarks].map((mark) => (
      <FulfillmentRecord key={mark.id} {...props} mark={mark} />
    ))}
  </section>
);
const FulfillmentRecord = ({ mark, ...props }: Props & Readonly<{ mark: Mark }>): JSX.Element => {
  const transaction = Array.findFirst(
    props.transactions,
    (entry) => entry.id === mark.transactionId
  );
  const name = Option.match(transaction, {
    onNone: () => "Transacción no disponible",
    onSome: (entry) => Option.getOrElse(entry.counterparty, () => "Contraparte no identificada"),
  });
  return (
    <article
      data-recurring-slot="fulfillment"
      aria-label={
        mark.transactionId === undefined ? "Marca manual" : `Transacción vinculada: ${name}`
      }
    >
      {mark.transactionId === undefined ? (
        <ManualMark mark={mark} />
      ) : (
        <LinkedFacts {...props} mark={mark} transaction={transaction} name={name} />
      )}
      <FulfillmentAction mark={mark} name={name} save={props.save} disabled={props.disabled} />
    </article>
  );
};
const ManualMark = ({ mark }: Readonly<{ mark: Mark }>): JSX.Element => (
  <>
    <p>
      {mark.actualDate} · {money(mark.money)} · Sin transacción vinculada
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
  item,
  categories,
  invalidMarks,
}: Pick<Props, "item" | "categories" | "invalidMarks"> &
  Readonly<{
    mark: Mark;
    transaction: Option.Option<Transaction>;
    name: string;
  }>): JSX.Element => {
  const invalid = invalidMarks.some((entry) => entry.id === mark.id);
  return (
    <>
      <div data-recurring-slot="fulfillment-identity">
        <h3>{name}</h3>
        <strong className="tabular-nums">
          {Option.match(transaction, {
            onNone: () => money(mark.money),
            onSome: (entry) => `${entry.direction === "inflow" ? "+" : "−"}${money(entry.money)}`,
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
const FulfillmentAction = ({
  mark,
  name,
  save,
  disabled,
}: Pick<Props, "save" | "disabled"> & Readonly<{ mark: Mark; name: string }>): JSX.Element => {
  const [reviewing, setReviewing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const linked = mark.transactionId !== undefined;
  return (
    <div className="grid gap-3">
      <Button
        ref={trigger}
        className="justify-self-start"
        contentLayout="wrap"
        variant="destructive"
        disabled={disabled}
        onClick={() =>
          linked ? setReviewing(true) : save({ kind: "reverse", fulfillmentId: mark.id })
        }
      >
        {linked ? "Desvincular transacción" : "Revertir"}
      </Button>
      {reviewing ? (
        <fieldset
          className="grid gap-3 border-t pt-3"
          aria-label={`Confirmar desvinculación: ${name}`}
        >
          <legend className="pt-3">¿Desvincular {name}?</legend>
          <p className="text-sm text-muted-foreground">
            Se retirará este registro del seguimiento de esta fecha. La transacción no se elimina de
            tu historial.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => {
                setReviewing(false);
                trigger.current?.focus();
              }}
            >
              Volver
            </Button>
            <Button
              contentLayout="wrap"
              variant="destructive"
              disabled={disabled}
              onClick={() => save({ kind: "reverse", fulfillmentId: mark.id })}
            >
              Confirmar desvinculación
            </Button>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
};
