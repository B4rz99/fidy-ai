import { type JSX, useState } from "react";
import { Option } from "effect";
import { Currency } from "@/transport/client";
import { CalendarField } from "@/ui/components/calendar-field";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { SearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";

type ChoiceProps = Readonly<{
  name: string;
  label: string;
  value: string;
  options: ReadonlyArray<Readonly<{ value: string; label: string }>>;
  onChange: (value: string) => void;
}>;
export const ChoiceField = ({ name, ...props }: ChoiceProps): JSX.Element => (
  <>
    <input type="hidden" name={name} value={props.value} />
    <ChoiceDropdown
      {...props}
      id={`recurring-${name}`}
      disabled={false}
      width="full"
      leading={null}
      triggerLabel={Option.none()}
    />
  </>
);
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
}: Readonly<{
  name: string;
  label: string;
  initial: string;
  timeZone: string;
  required: boolean;
}>): JSX.Element => {
  const [value, setValue] = useState(initial);
  return (
    <>
      <input type="hidden" name={name} value={value} />
      <CalendarField
        id={`recurring-${name}`}
        label={label}
        value={value}
        timeZone={timeZone}
        disabled={false}
        required={required}
        appearance="field"
        onChange={setValue}
      />
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
        options={Currency.literals.map((currency) => ({ value: currency, label: currency }))}
        disabled={false}
        width="full"
        onChange={setValue}
      />
    </>
  );
};
