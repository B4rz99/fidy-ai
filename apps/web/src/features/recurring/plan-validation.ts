import { Option } from "effect";
import { type AriaAttributes, createContext, use } from "react";

export type PlanProblem = Readonly<{
  field: "cardPayment" | "endDate" | "day1" | "day2";
  message: string;
  clearedBy: ReadonlyArray<string>;
}>;

export type PlanDraft = Readonly<{
  kind: string;
  cardPayment: boolean;
  frequency: string;
  firstDate: string;
  endDate: string;
  day1: string;
  day2: string;
}>;

export type MonthDay = number | "last";

const maximumMonthDay = 31;

export const parseMonthDay = (text: string): Option.Option<MonthDay> => {
  const normalized = text.trim().toLowerCase();

  if (normalized === "último" || normalized === "ultimo" || normalized === "last") {
    return Option.some("last");
  }

  const day = /^\d{1,2}$/.test(normalized) ? Number(normalized) : 0;

  return day >= 1 && day <= maximumMonthDay ? Option.some(day) : Option.none();
};

const monthDayProblems = (draft: PlanDraft): ReadonlyArray<PlanProblem> => {
  if (draft.frequency !== "twice-monthly") return [];
  const first = parseMonthDay(draft.day1);
  const second = parseMonthDay(draft.day2);

  const unreadable = (
    [
      ["day1", first],
      ["day2", second],
    ] as const
  ).flatMap(([field, day]) =>
    Option.isNone(day)
      ? [
          {
            field,
            message: `Escribe un día del 1 al ${maximumMonthDay} o «último».`,
            clearedBy: [field],
          },
        ]
      : []
  );

  const repeated = Option.isSome(first) && Option.isSome(second) && first.value === second.value;

  return repeated
    ? [
        {
          field: "day2",
          message: "Elige un día diferente del primero.",
          clearedBy: ["day1", "day2"],
        },
      ]
    : unreadable;
};

const cardPaymentProblem = (draft: PlanDraft): Option.Option<PlanProblem> =>
  Option.map(
    Option.liftPredicate(draft, (plan) => plan.cardPayment && plan.kind !== "transfer"),
    () => ({
      field: "cardPayment",
      message: "Un pago de tarjeta debe tener el tipo Transferencia.",
      clearedBy: ["cardPayment", "kind"],
    })
  );

const endDateProblem = (draft: PlanDraft): Option.Option<PlanProblem> =>
  Option.map(
    Option.liftPredicate(
      draft,
      (plan) => plan.firstDate !== "" && plan.endDate !== "" && plan.endDate < plan.firstDate
    ),
    () => ({
      field: "endDate",
      message: "La fecha final debe ser igual o posterior a la primera fecha.",
      clearedBy: ["firstDate", "endDate"],
    })
  );

export const findPlanProblems = (draft: PlanDraft): ReadonlyArray<PlanProblem> => [
  ...Option.toArray(cardPaymentProblem(draft)),
  ...Option.toArray(endDateProblem(draft)),
  ...monthDayProblems(draft),
];

type PlanFeedback = Readonly<{
  problems: ReadonlyArray<PlanProblem>;
  edited: (field: string) => void;
}>;

export const PlanFeedbackContext = createContext<PlanFeedback>({
  problems: [],
  edited: () => undefined,
});

export const usePlanFieldProblem = (field: string): Option.Option<PlanProblem> =>
  Option.fromNullishOr(
    use(PlanFeedbackContext).problems.find((problem) => problem.field === field)
  );

export const usePlanFieldEdited = (): PlanFeedback["edited"] => use(PlanFeedbackContext).edited;

export const planProblemId = (field: string): string => `recurring-${field}-error`;

export const usePlanFieldAria = (
  field: string
): Pick<AriaAttributes, "aria-invalid" | "aria-describedby"> =>
  Option.isSome(usePlanFieldProblem(field))
    ? { "aria-invalid": true, "aria-describedby": planProblemId(field) }
    : {};
