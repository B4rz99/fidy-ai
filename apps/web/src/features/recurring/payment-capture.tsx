import { formatMoneyInput } from "@/transport/money-input";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useRouter } from "@tanstack/react-router";
import { Data, Option } from "effect";
import { Atom, Reactivity } from "effect/reactivity";
import { type JSX, useState } from "react";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import { CaptureEditor } from "./capture-editor";
import type { CaptureEditorProps } from "./capture-context";
import { Button } from "@/ui/components/button";
import { DeferredDisclosure } from "@/ui/components/disclosure";
import { ChoiceField } from "./fields";
import { Field } from "./form-fields";
import { recurringWorkspaceKey } from "./controller";
import { type Category, type Occurrence, type Save, money } from "./model";
import {
  type PaymentAssociation,
  associateTransaction,
  associationBlocked,
  defaultAssociation,
  manualMarks,
  replacementOptions,
  settlementOptions,
} from "./payment-association";

type Captured = CanonicalSuccess<"transactions.createTransaction">["data"];
type CapturedPayment = Readonly<{ transaction: Captured }> & PaymentAssociation;
type CaptureState = Readonly<{
  intent: number;
  transaction: Option.Option<CapturedPayment>;
}>;
class CaptureKey extends Data.Class<
  Readonly<{ client: FidyClient; planId: Occurrence["planId"]; date: string }>
> {}
const captures = Atom.family((_key: CaptureKey) =>
  Atom.make<CaptureState>({ intent: 0, transaction: Option.none() }).pipe(Atom.keepAlive)
);
type Props = Readonly<{
  item: Occurrence;
  categories: ReadonlyArray<Category>;
  save: Save;
  disabled: boolean;
  today: string;
}>;

export const PaymentCapture = (props: Props): JSX.Element => (
  <DeferredDisclosure title="Crear y vincular transacción">
    <p className="my-3 text-sm text-muted-foreground">
      Primero crea la transacción y luego vincúlala a este recurrente. Se añadirá a tu historial y,
      si es un gasto, contará en los presupuestos de su categoría, moneda y mes. Si ya está en tu
      historial, vincula la existente para evitar duplicados.
    </p>
    <CapturePayment {...props} />
  </DeferredDisclosure>
);

const CapturePayment = ({ item, categories, save, disabled, today }: Props): JSX.Element => {
  const router = useRouter();
  const client = router.options.context.apiClient;
  const resource = captures(new CaptureKey({ client, planId: item.planId, date: item.date }));
  const state = useAtomValue(resource);
  const setState = useAtomSet(resource);
  const [refreshCommand] = useState(() =>
    client.runtime.fn<void>()(() => Reactivity.invalidate([recurringWorkspaceKey]))
  );
  const refresh = useAtomSet(refreshCommand);
  const [draft, setDraft] = useState(() => defaultAssociation(item));
  const association = Option.getOrElse(state.transaction, () => draft);
  const linked = Option.exists(state.transaction, (captured) =>
    item.fulfillments.some((mark) => mark.transactionId === captured.transaction.id)
  );
  const change = (next: PaymentAssociation): void => {
    if (Option.isSome(state.transaction)) {
      setState({ ...state, transaction: Option.some({ ...state.transaction.value, ...next }) });
    } else setDraft(next);
  };
  const restart = (): void => {
    setDraft(defaultAssociation(item));
    setState({ intent: state.intent + 1, transaction: Option.none() });
  };
  return (
    <>
      {linked || Option.isNone(state.transaction) ? null : (
        <CaptureAssociation
          item={item}
          association={association}
          change={change}
          disabled={disabled}
        />
      )}
      <CaptureEntry
        {...{
          item,
          categories,
          save,
          today,
          state,
          setState,
          refresh,
          restart,
          association,
          change,
          disabled,
        }}
      />
    </>
  );
};

const CaptureAssociation = ({
  item,
  association,
  change,
  disabled,
}: Pick<Props, "item" | "disabled"> &
  Readonly<{
    association: PaymentAssociation;
    change: (value: PaymentAssociation) => void;
  }>): JSX.Element => (
  <fieldset disabled={disabled} className="grid gap-3 py-3">
    <Field label="Marca manual que reemplaza" name="capture-replaces">
      <ChoiceField
        name="capture-replaces"
        label="Marca manual que reemplaza"
        value={association.replaces}
        onChange={(replaces) => change({ ...association, replaces })}
        options={replacementOptions(item)}
      />
    </Field>
    <Field label="Estado de la transacción vinculada" name="capture-settlement">
      <ChoiceField
        name="capture-settlement"
        label="Estado de la transacción vinculada"
        value={association.settled ? "settled" : "partial"}
        onChange={(value) => change({ ...association, settled: value === "settled" })}
        options={settlementOptions}
      />
    </Field>
    {association.replaces !== "" &&
    !manualMarks(item).some((mark) => mark.id === association.replaces) ? (
      <p>
        La marca seleccionada ya no existe. Elige Ninguno o una marca vigente antes de vincular.
      </p>
    ) : null}
  </fieldset>
);

type EntryProps = Props &
  Readonly<{
    association: PaymentAssociation;
    change: (value: PaymentAssociation) => void;
    restart: () => void;
    state: CaptureState;
    setState: (value: CaptureState | ((previous: CaptureState) => CaptureState)) => void;
    refresh: () => void;
  }>;
const CaptureEntry = ({
  item,
  categories,
  save,
  disabled,
  today,
  association,
  change,
  restart,
  state,
  setState,
  refresh,
}: EntryProps): JSX.Element => {
  const { navigate } = useRouter();
  return Option.isSome(state.transaction) ? (
    <CreatedPayment
      item={item}
      {...state.transaction.value}
      save={save}
      disabled={disabled}
      restart={restart}
    />
  ) : (
    <CaptureEditor
      intentId={`recurring:${item.planId}:${item.date}:${state.intent}`}
      categories={categories}
      currency={item.plan.currency}
      direction={item.plan.kind === "income" ? "inflow" : "outflow"}
      initial={captureInitial({ item, replaces: association.replaces, today })}
      disabled={disabled || associationBlocked({ item, replaces: association.replaces })}
      timeZone={item.plan.timeZone}
      onInvalidate={refresh}
      renderForm={(form, placement) => (
        <>
          <CaptureAssociation
            item={item}
            association={association}
            change={change}
            disabled={disabled || placement.saving || placement.uncertain}
          />
          {form}
        </>
      )}
      onCreated={(transaction) => {
        setState({
          intent: state.intent,
          transaction: Option.some({
            transaction,
            ...association,
          }),
        });
      }}
      onCheckHistory={() => {
        navigate({ to: "/app/transactions" }).catch(() => undefined);
      }}
    />
  );
};
const remainingMoney = (item: Occurrence): Option.Option<Occurrence["completed"]> =>
  Option.fromUndefinedOr(item.remaining ?? item.plan.money);

const captureInitial = ({
  item,
  replaces,
  today,
}: Pick<Props, "item" | "today"> &
  Readonly<{ replaces: string }>): CaptureEditorProps["initial"] => {
  const mark = manualMarks(item).find((entry) => entry.id === replaces);
  const actual = mark === undefined ? remainingMoney(item) : Option.some(mark.money);
  return {
    amount: Option.match(actual, {
      onNone: () => "",
      onSome: formatMoneyInput,
    }),
    occurredOn: mark?.actualDate ?? today,
    counterparty: item.plan.counterparty ?? "",
    categoryId: item.plan.categoryId ?? "",
  };
};

const CreatedPayment = ({
  item,
  transaction,
  replaces,
  settled,
  save,
  disabled,
  restart,
}: Pick<Props, "item" | "save" | "disabled"> &
  Readonly<{
    transaction: Captured;
    replaces: string;
    settled: boolean;
    restart: () => void;
  }>): JSX.Element => {
  const linked = item.fulfillments.some((mark) => mark.transactionId === transaction.id);
  return (
    <div className="grid gap-3 py-3">
      <output>
        {linked ? "Transacción vinculada." : "Transacción creada. Falta vincularla al recurrente."}
      </output>
      <p>{money(transaction.money)}</p>
      <Link to="/app/transactions" className="text-sm underline">
        Ver transacciones
      </Link>
      {linked ? null : (
        <Button
          disabled={disabled || associationBlocked({ item, replaces })}
          onClick={() => save(associateTransaction({ item, transaction, replaces, settled }))}
        >
          Vincular transacción creada
        </Button>
      )}
      {linked && item.status !== "completed" ? (
        <Button disabled={disabled} onClick={restart}>
          Registrar otro pago o ingreso
        </Button>
      ) : null}
      {linked ? null : (
        <p className="text-sm text-muted-foreground">
          La transacción ya está en tu historial. Si el vínculo falla, actualiza los recurrentes y
          vuelve a vincularla; no necesitas crear otra.
        </p>
      )}
    </div>
  );
};
