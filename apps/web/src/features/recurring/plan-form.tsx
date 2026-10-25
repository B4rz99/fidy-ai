import { BigDecimal, Option, Schema } from "effect";
import { type FormEvent, type JSX, useState } from "react";
import { RecurringPlanInput } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { ChoiceField } from "./fields";
import { Field, IdentityFields, ScheduleFields } from "./form-fields";
import type { Category, PlanInput } from "./model";

const value = (form: FormData, key: string): string => {
  const entry = form.get(key);
  return typeof entry === "string" ? entry.trim() : "";
};
const day = (text: string): number | "last" =>
  text === "último" || text === "last" ? "last" : Number(text);
const parsePlan = (form: FormData, timeZone: PlanInput["timeZone"]): Option.Option<PlanInput> => {
  const currency = value(form, "currency").toUpperCase();
  const amountMode = value(form, "amountMode");
  const frequency = value(form, "frequency");
  const optional = Object.fromEntries(
    ["endDate", "counterparty", "categoryId"].flatMap((key) =>
      value(form, key) === "" ? [] : [[key, value(form, key)]]
    )
  );
  return Schema.decodeOption(Schema.toCodecJson(RecurringPlanInput))({
    name: value(form, "name"),
    kind: value(form, "kind"),
    currency,
    amountMode,
    frequency,
    timeZone,
    firstDate: value(form, "firstDate"),
    cardPayment: value(form, "cardPayment") === "yes",
    ...optional,
    ...(amountMode === "unknown" ? {} : { money: { amount: value(form, "amount"), currency } }),
    ...(frequency === "twice-monthly"
      ? { monthDays: [day(value(form, "day1")), day(value(form, "day2"))] }
      : {}),
  });
};
export const PlanForm = ({
  initial,
  categories,
  disabled,
  onSubmit,
}: Readonly<{
  initial: Partial<PlanInput> & Pick<PlanInput, "timeZone">;
  categories: ReadonlyArray<Category>;
  disabled: boolean;
  onSubmit: (plan: PlanInput) => void;
}>): JSX.Element => {
  const [amountMode, setAmountMode] = useState(initial.amountMode ?? "unknown");
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = parsePlan(new FormData(event.currentTarget), initial.timeZone);
    setInvalid(Option.isNone(parsed));
    if (Option.isSome(parsed)) onSubmit(parsed.value);
  };
  return (
    <form onSubmit={submit} data-recurring-slot="plan-form" className="grid gap-4">
      <fieldset disabled={disabled} className="grid gap-4">
        <IdentityFields initial={initial} />
        <AmountFields initial={initial} amountMode={amountMode} setAmountMode={setAmountMode} />
        <ScheduleFields initial={initial} categories={categories} />
        {invalid ? (
          <p role="alert">
            Revisa la fecha, moneda e importe. Un pago de tarjeta debe ser una transferencia.
          </p>
        ) : null}
        <Button contentLayout="wrap" focusAppearance="subtle" type="submit">
          Guardar
        </Button>
      </fieldset>
    </form>
  );
};

const AmountFields = ({
  initial,
  amountMode,
  setAmountMode,
}: Readonly<{
  initial: Partial<PlanInput>;
  amountMode: PlanInput["amountMode"];
  setAmountMode: (value: PlanInput["amountMode"]) => void;
}>): JSX.Element => (
  <>
    <Field label="Tipo de importe" name="amountMode">
      <ChoiceField
        name="amountMode"
        label="Tipo de importe"
        value={amountMode}
        options={[
          { value: "unknown", label: "Por confirmar" },
          { value: "fixed", label: "Fijo" },
          { value: "estimated", label: "Estimado" },
        ]}
        onChange={(value) => {
          const parsed = Schema.decodeUnknownOption(RecurringPlanInput.fields.amountMode)(value);
          if (Option.isSome(parsed)) setAmountMode(parsed.value);
        }}
      />
    </Field>
    {amountMode !== "unknown" ? (
      <Field label="Importe" name="amount">
        <Input
          id="recurring-amount"
          name="amount"
          required
          inputMode="decimal"
          defaultValue={initial.money === undefined ? "" : BigDecimal.format(initial.money.amount)}
        />
      </Field>
    ) : null}
  </>
);
