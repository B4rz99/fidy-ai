import { Option, Schema, Struct } from "effect";
import { RecurringPlanInput } from "@/transport/client";
import type { PlanInput } from "./model";
import { type PlanDraft, parseMonthDay } from "./plan-validation";

const formValue = (form: FormData, key: string): string => {
  const entry = form.get(key);

  return typeof entry === "string" ? entry.trim() : "";
};

export const planDraft = (form: FormData): PlanDraft => ({
  kind: formValue(form, "kind"),
  cardPayment: formValue(form, "cardPayment") === "yes",
  frequency: formValue(form, "frequency"),
  firstDate: formValue(form, "firstDate"),
  endDate: formValue(form, "endDate"),
  day1: formValue(form, "day1"),
  day2: formValue(form, "day2"),
});

type FormPlan = Readonly<{ form: FormData; timeZone: PlanInput["timeZone"] }>;

export const planFields = ({ form, timeZone }: FormPlan): Schema.JsonObject => {
  const currency = formValue(form, "currency").toUpperCase();
  const amountMode = formValue(form, "amountMode");
  const frequency = formValue(form, "frequency");

  const optional = Object.fromEntries(
    ["endDate", "counterparty", "categoryId"].flatMap((key) =>
      formValue(form, key) === "" ? [] : [[key, formValue(form, key)]]
    )
  );

  return {
    name: formValue(form, "name"),
    kind: formValue(form, "kind"),
    currency,
    amountMode,
    frequency,
    timeZone,
    firstDate: formValue(form, "firstDate"),
    cardPayment: formValue(form, "cardPayment") === "yes",
    ...optional,
    ...(amountMode === "unknown" ? {} : { money: { amount: formValue(form, "amount"), currency } }),
    ...(frequency === "twice-monthly"
      ? Option.match(
          Option.all([
            parseMonthDay(formValue(form, "day1")),
            parseMonthDay(formValue(form, "day2")),
          ]),
          {
            onNone: () => ({}),
            onSome: (monthDays) => ({ monthDays }),
          }
        )
      : {}),
  };
};

const decodeField = Schema.decodeUnknownOption(
  Schema.toCodecJson(RecurringPlanInput.mapFields(Struct.map(Schema.optionalKey)))
);

export const restoredPlan = ({
  form,
  timeZone,
}: FormPlan): Partial<PlanInput> & Pick<PlanInput, "timeZone"> => ({
  ...Object.entries(planFields({ form, timeZone })).reduce<Partial<PlanInput>>(
    (plan, [key, field]) =>
      Option.match(decodeField({ [key]: field }), {
        onNone: () => plan,
        onSome: (decoded) => ({ ...plan, ...decoded }),
      }),
    {}
  ),
  timeZone,
});
