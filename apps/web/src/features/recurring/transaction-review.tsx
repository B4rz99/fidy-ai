import { type JSX, useState } from "react";
import { Option } from "effect";
import type { CanonicalSuccess } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { ChoiceField } from "./fields";
import { Field } from "./form-fields";
import { type Occurrence, type Save, money } from "./model";
import {
  type PaymentAssociation,
  associateTransaction,
  associationBlocked,
  defaultAssociation,
  manualMarks,
  replacementOptions,
  settlementOptions,
} from "./payment-association";
import { transactionDate } from "./transaction-filters";

type Transaction = CanonicalSuccess<"transactions.listTransactions">["data"][number];
type Props = Readonly<{
  item: Occurrence;
  transaction: Transaction;
  disabled: boolean;
  save: Save;
}>;
export const TransactionReview = ({ item, transaction, disabled, save }: Props): JSX.Element => {
  const [association, setAssociation] = useState(() => defaultAssociation(item));
  const linked = item.fulfillments.some((mark) => mark.transactionId === transaction.id);
  return (
    <>
      <CandidateDetails transaction={transaction} timeZone={item.plan.timeZone} />
      <AssociationForm
        {...{ item, association }}
        change={setAssociation}
        disabled={disabled || linked}
      />
      <LinkAction {...{ item, transaction, disabled, save, association, linked }} />
      <p className="text-xs text-muted-foreground">
        Asociarás un registro existente. No se crea otra transacción ni se suma el gasto de nuevo.
      </p>
    </>
  );
};
const AssociationForm = ({
  item,
  association,
  change,
  disabled,
}: Readonly<{
  item: Occurrence;
  association: PaymentAssociation;
  change: (value: PaymentAssociation) => void;
  disabled: boolean;
}>): JSX.Element => (
  <fieldset disabled={disabled} className="grid gap-4 border-b pb-5">
    {manualMarks(item).length > 0 ? (
      <Field label="Registro manual que reemplaza" name="linked-replaces">
        <ChoiceField
          name="linked-replaces"
          label="Registro manual que reemplaza"
          value={association.replaces}
          onChange={(replaces) => change({ ...association, replaces })}
          options={replacementOptions(item)}
        />
      </Field>
    ) : null}
    <Field label="¿Cómo cubre esta ocurrencia?" name="linked-settlement">
      <ChoiceField
        name="linked-settlement"
        label="Estado de la transacción vinculada"
        value={association.settled ? "settled" : "partial"}
        onChange={(value) => change({ ...association, settled: value === "settled" })}
        options={settlementOptions}
      />
    </Field>
    <p className="text-xs text-muted-foreground">
      {association.settled
        ? "Marcarás esta ocurrencia como completa, aunque el importe sea diferente al esperado."
        : "Registrarás este importe sin marcar la ocurrencia como completa."}
    </p>
  </fieldset>
);
const LinkAction = ({
  item,
  transaction,
  disabled,
  save,
  association,
  linked,
}: Props & Readonly<{ association: PaymentAssociation; linked: boolean }>): JSX.Element => {
  const compatible =
    transaction.money.currency === item.plan.currency &&
    transaction.direction === (item.plan.kind === "income" ? "inflow" : "outflow");
  const blocked = associationBlocked({ item, replaces: association.replaces });
  if (linked) return <output>Transacción vinculada.</output>;
  return (
    <>
      {!compatible ? (
        <output className="text-sm">
          Elige una transacción en {item.plan.currency} con la dirección de este recurrente.
        </output>
      ) : null}
      {blocked ? (
        <p className="text-sm">
          Revisa las marcas manuales de esta ocurrencia antes de vincularla para no contar dos veces
          el seguimiento.
        </p>
      ) : null}
      <Button
        disabled={disabled || blocked || !compatible}
        onClick={() => save(associateTransaction({ item, transaction, ...association }))}
      >
        Vincular transacción
      </Button>
    </>
  );
};
const CandidateDetails = ({
  transaction,
  timeZone,
}: Readonly<{ transaction: Transaction; timeZone: string }>): JSX.Element => (
  <div className="border-b pb-5">
    <p className="text-xs text-muted-foreground">Transacción seleccionada</p>
    <h3 className="mt-3 font-semibold">
      {Option.getOrElse(transaction.counterparty, () => "Contraparte no identificada")}
    </h3>
    <p className="my-3 text-2xl font-semibold tabular-nums">
      {transaction.direction === "inflow" ? "+" : "−"}
      {money(transaction.money)}
    </p>
    <dl className="grid gap-3 text-sm">
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Fecha</dt>
        <dd>{transactionDate({ transaction, timeZone })}</dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Dirección</dt>
        <dd>{transaction.direction === "inflow" ? "Entrada" : "Salida"}</dd>
      </div>
      {Option.isSome(transaction.notes) ? (
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Nota</dt>
          <dd className="min-w-0 text-right [overflow-wrap:anywhere]">{transaction.notes.value}</dd>
        </div>
      ) : null}
    </dl>
  </div>
);
