import { type JSX, useId, useState } from "react";
import { Option } from "effect";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { CalendarField } from "@/ui/components/calendar-field";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { Currency } from "@/transport/client";
import { SearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";
import {
  type TransactionFilters,
  type TransactionSearch,
  emptyTransactionFilters,
  transactionSearch,
} from "./transaction-filters";

type Props = Readonly<{
  draft: TransactionFilters;
  setDraft: (draft: TransactionFilters) => void;
  timeZone: string;
  apply: (query: TransactionSearch) => void;
}>;
const currencyOptions = [
  { value: "", label: "Todas las monedas" },
  ...Currency.literals.map((value) => ({ value, label: value })),
];
export const TransactionSearchForm = ({ draft, setDraft, timeZone, apply }: Props): JSX.Element => {
  const [invalid, setInvalid] = useState(false);
  const change =
    (field: keyof TransactionFilters) =>
    (value: string): void =>
      setDraft({ ...draft, [field]: value });
  const submit = (value: TransactionFilters): void => {
    const query = transactionSearch({ draft: value, timeZone });
    setInvalid(Option.isNone(query));
    Option.map(query, apply);
  };
  const id = useId();
  return (
    <form
      aria-label="Buscar en el historial"
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit(draft);
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor={`${id}-text`}>Buscar transacción</Label>
        <Input
          id={`${id}-text`}
          type="search"
          minLength={2}
          maxLength={80}
          value={draft.text}
          placeholder="Contraparte o nota"
          onChange={(event) => change("text")(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Busca en todo tu historial registrado. Aplica los filtros con Buscar.
        </p>
      </div>
      <DirectionCurrencyFields {...{ draft, change, id }} />
      <DateAmountFields {...{ draft, change, id, timeZone }} />
      {invalid ? <SearchValidation /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline">
          Buscar
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setDraft(emptyTransactionFilters);
            submit(emptyTransactionFilters);
          }}
        >
          Limpiar filtros
        </Button>
      </div>
    </form>
  );
};
const DateAmountFields = ({
  draft,
  change,
  id,
  timeZone,
}: Readonly<{
  draft: TransactionFilters;
  change: (field: keyof TransactionFilters) => (value: string) => void;
  id: string;
  timeZone: string;
}>): JSX.Element => (
  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
    {(["from", "to"] as const).map((field) => (
      <div key={field} className="grid gap-2">
        <Label htmlFor={`${id}-${field}`}>{field === "from" ? "Desde" : "Hasta"}</Label>
        <CalendarField
          id={`${id}-${field}`}
          label={field === "from" ? "Desde" : "Hasta"}
          value={draft[field]}
          timeZone={timeZone}
          disabled={false}
          required={false}
          appearance="field"
          onChange={change(field)}
        />
      </div>
    ))}
    <div className="col-span-2 grid gap-2 sm:col-span-1">
      <Label htmlFor={`${id}-amount`}>Importe exacto</Label>
      <Input
        id={`${id}-amount`}
        inputMode="text"
        placeholder="Cualquier importe"
        value={draft.amount}
        onChange={(event) => change("amount")(event.target.value)}
      />
    </div>
  </div>
);

const DirectionCurrencyFields = ({
  draft,
  change,
  id,
}: Readonly<{
  draft: TransactionFilters;
  change: (field: keyof TransactionFilters) => (value: string) => void;
  id: string;
}>): JSX.Element => (
  <div className="flex flex-wrap gap-2">
    <ChoiceDropdown
      id={`${id}-direction`}
      label="Dirección"
      value={draft.direction}
      onChange={change("direction")}
      options={[
        { value: "", label: "Todas las direcciones" },
        { value: "outflow", label: "Salidas" },
        { value: "inflow", label: "Entradas" },
      ]}
      disabled={false}
      width="auto"
      leading={null}
      triggerLabel={Option.none()}
    />
    <SearchableChoiceDropdown
      id={`${id}-currency`}
      label="Moneda"
      value={draft.currency}
      onChange={change("currency")}
      options={currencyOptions}
      disabled={false}
      width="auto"
    />
  </div>
);

const SearchValidation = (): JSX.Element => (
  <p role="alert" className="text-sm">
    Revisa las fechas. Para filtrar por importe, elige una moneda y usa el formato 89.900,50.
  </p>
);
