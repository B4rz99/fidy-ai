import { Option } from "effect";
import { type JSX, useState } from "react";
import { AmountInput } from "@/ui/components/amount-input";
import { Label } from "@/ui/components/label";
import { moneyInputError, moneyInputHint } from "@/transport/money-input";
import type { Transaction } from "./presentation";

type MoneyFieldProps = Readonly<{
  id: string;
  currency: Transaction["money"]["currency"];
  label: string;
  value: string;
  onChange: (value: string) => void;
  required: boolean;
  disabled: boolean;
  revealErrors: boolean;
}>;

export const MoneyField = ({
  id,
  currency,
  label,
  value,
  onChange,
  required,
  disabled,
  revealErrors,
}: MoneyFieldProps): JSX.Element => {
  const [visited, setVisited] = useState(false);
  const error =
    disabled || (!required && value === "") || !(visited || revealErrors)
      ? Option.none()
      : moneyInputError({ text: value, currency });
  const invalid = Option.isSome(error);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <AmountInput
        width="full"
        id={id}
        required={required}
        placeholder={moneyPlaceholder(required)}
        disabled={disabled}
        aria-describedby={`${id}-help`}
        aria-invalid={invalid}
        value={value}
        onBlur={() => setVisited(true)}
        onValueChange={onChange}
      />
      {!disabled ? (
        <p id={`${id}-help`} aria-live="polite" className="text-sm text-muted-foreground">
          {Option.getOrElse(error, () => moneyInputHint(currency))}
        </p>
      ) : null}
    </div>
  );
};

const moneyPlaceholder = (required: boolean): string => (required ? "" : "Sin cambiar");
