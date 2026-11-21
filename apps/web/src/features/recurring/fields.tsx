import { type JSX, useState } from "react";
import { Option } from "effect";
import { Currency } from "@/transport/client";
import { CalendarField } from "@/ui/components/calendar-field";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { SearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";
import { usePlanFieldAria, usePlanFieldEdited } from "./plan-validation";
import { currencyChoices } from "@/ui/currency-choices";

type ChoiceProps = Readonly<{
  name: string;
  label: string;
  value: string;
  options: ReadonlyArray<Readonly<{ value: string; label: string }>>;
  onChange: (value: string) => void;
}>;
export const ChoiceField = ({ name, onChange, ...props }: ChoiceProps): JSX.Element => {
  const aria = usePlanFieldAria(name);
  const edited = usePlanFieldEdited();
  return (
    <>
      <input type="hidden" name={name} value={props.value} />
      <ChoiceDropdown
        {...props}
        {...aria}
        id={`recurring-${name}`}
        disabled={false}
        width="full"
        leading={null}
        triggerLabel={Option.none()}
        onChange={(value) => {
          edited(name);
          onChange(value);
        }}
      />
    </>
  );
};
export const DefaultChoiceField = ({
  initial,
  ...props
}: Omit<ChoiceProps, "value" | "onChange"> & Readonly<{ initial: string }>): JSX.Element => {
  const [value, setValue] = useState(initial);
  return <ChoiceField {...props} value={value} onChange={setValue} />;
};
export const RecurringDateField = ({
  name,
  label,
  initial,
  timeZone,
  required,
  note,
}: Readonly<{
  name: string;
  label: string;
  initial: string;
  timeZone: string;
  required: boolean;
  note: (value: string) => Option.Option<string>;
}>): JSX.Element => {
  const [value, setValue] = useState(initial);
  const aria = usePlanFieldAria(name);
  const edited = usePlanFieldEdited();
  return (
    <>
      <input type="hidden" name={name} value={value} />
      <CalendarField
        {...aria}
        id={`recurring-${name}`}
        label={label}
        value={value}
        timeZone={timeZone}
        disabled={false}
        required={required}
        appearance="field"
        onChange={(next) => {
          edited(name);
          setValue(next);
        }}
      />
      <output htmlFor={`recurring-${name}`} className="text-xs text-muted-foreground empty:hidden">
        {Option.getOrElse(note(value), () => "")}
      </output>
    </>
  );
};
export const CurrencyField = ({ initial }: Readonly<{ initial: string }>): JSX.Element => {
  const [value, setValue] = useState(initial);
  return (
    <>
      <input type="hidden" name="currency" value={value} />
      <SearchableChoiceDropdown
        id="recurring-currency"
        label="Moneda"
        value={value}
        options={currencyChoices(Currency.literals)}
        disabled={false}
        width="full"
        onChange={setValue}
      />
    </>
  );
};
