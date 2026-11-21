import { BigDecimal, Option, Schema } from "effect";
import { type FormEvent, type JSX, useState } from "react";
import { RecurringPlanInput } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { ChoiceField } from "./fields";
import { Field, IdentityFields, ScheduleFields } from "./form-fields";
import type { Category, PlanInput } from "./model";
import { PlanFeedbackContext, type PlanProblem, findPlanProblems } from "./plan-validation";
import { planDraft, planFields } from "./plan-fields";

const parsePlan = (form: FormData, timeZone: PlanInput["timeZone"]): Option.Option<PlanInput> =>
  Schema.decodeOption(Schema.toCodecJson(RecurringPlanInput))(planFields({ form, timeZone }));
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
  const [problems, setProblems] = useState<ReadonlyArray<PlanProblem>>([]);
  const edited = (field: string): void =>
    setProblems((current) =>
      current.some((problem) => problem.clearedBy.includes(field))
        ? current.filter((problem) => !problem.clearedBy.includes(field))
        : current
    );
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const found = findPlanProblems(planDraft(form));
    const parsed = found.length === 0 ? parsePlan(form, initial.timeZone) : Option.none();
    setProblems(found);
    setInvalid(found.length === 0 && Option.isNone(parsed));
    const first = found[0];
    if (first !== undefined) {
      event.currentTarget.querySelector<HTMLElement>(`#recurring-${first.field}`)?.focus();
    }
    if (Option.isSome(parsed)) onSubmit(parsed.value);
  };
  return (
    <form
      onSubmit={submit}
      onChange={(event) => {
        if (event.target instanceof HTMLInputElement) edited(event.target.name);
      }}
      data-recurring-slot="plan-form"
      className="grid gap-4"
    >
      <PlanFeedbackContext value={{ problems, edited }}>
        <fieldset disabled={disabled} className="grid gap-4">
          <IdentityFields initial={initial} />
          <AmountFields initial={initial} amountMode={amountMode} setAmountMode={setAmountMode} />
          <ScheduleFields initial={initial} categories={categories} />
          {invalid ? (
            <p role="alert">
              No pudimos guardar el recurrente. Revisa el nombre, la moneda y el importe.
            </p>
          ) : null}
          <Button contentLayout="wrap" focusAppearance="subtle" type="submit">
            Guardar
          </Button>
        </fieldset>
      </PlanFeedbackContext>
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
