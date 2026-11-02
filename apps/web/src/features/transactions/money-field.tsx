import { Option } from "effect";
import type { JSX } from "react";
import { AmountInput } from "@/ui/components/amount-input";
import { Label } from "@/ui/components/label";
import { moneyInputHint, parseMoneyInput } from "@/transport/money-input";
import type { Transaction } from "./presentation";

type MoneyFieldProps = Readonly<{
  id: string;
  currency: Transaction["money"]["currency"];
  currencyLabel: string;
  value: string;
  onChange: (value: string) => void;
  required: boolean;
  disabled: boolean;
}>;

const MoneyFeedback = ({
  id,
  currency,
  disabled,
  invalid,
}: Pick<MoneyFieldProps, "id" | "currency" | "disabled"> &
  Readonly<{
    invalid: boolean;
  }>): JSX.Element => {
  if (disabled) return <></>;
  return (
    <p
      id={`${id}-help`}
      role={invalid ? "alert" : undefined}
      className="text-sm text-muted-foreground"
    >
      {invalid ? "Ingresa un monto mayor que cero. " : ""}
      {moneyInputHint(currency)}
    </p>
  );
};

export const MoneyField = ({
  id,
  currency,
  currencyLabel,
  value,
  onChange,
  required,
  disabled,
}: MoneyFieldProps): JSX.Element => {
  const money = parseMoneyInput({ text: value, currency });
  const invalid = !disabled && value !== "" && Option.isNone(money);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>Monto · {currencyLabel}</Label>
      <AmountInput
        width="full"
        id={id}
        required={required}
        placeholder={required ? undefined : "Sin cambiar"}
        disabled={disabled}
        aria-describedby={`${id}-help`}
        aria-invalid={invalid}
        value={value}
        onValueChange={onChange}
      />
      <MoneyFeedback id={id} currency={currency} disabled={disabled} invalid={invalid} />
    </div>
  );
};
