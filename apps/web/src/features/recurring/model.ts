import { DateTime, Option } from "effect";
import type { CanonicalInput, CanonicalSuccess } from "@/transport/client";
import { formatMoneyWithCode } from "@/transport/money";

export type Workspace = CanonicalSuccess<"recurringPlans.getRecurringWorkspace">["data"];
export type Occurrence = Workspace["occurrences"][number];
export type Plan = Workspace["document"]["plans"][number];
export type PlanInput = Plan["revisions"][number]["plan"];
export type Edit = CanonicalInput<"recurringPlans.applyRecurringEdit">["payload"]["edit"];
export type Filters = Omit<
  CanonicalInput<"recurringPlans.getRecurringWorkspace">["query"],
  "month" | "previousMonth"
>;
export type Category = CanonicalSuccess<"categories.listCategories">["data"][number];
export type Save = (edit: Edit) => void;
export const frequencies = [
  ["weekly", "Cada semana"],
  ["fortnightly", "Cada 2 semanas"],
  ["twice-monthly", "Dos veces al mes"],
  ["monthly", "Cada mes"],
  ["quarterly", "Cada 3 meses"],
  ["half-yearly", "Cada 6 meses"],
  ["yearly", "Cada año"],
] as const;
export const kinds = [
  ["income", "Ingresos"],
  ["expense", "Gastos"],
  ["transfer", "Transferencias"],
] as const;
export const statuses = {
  upcoming: "Próximos",
  unconfirmed: "Sin confirmar",
  partial: "Parcial",
  completed: "Completados",
  skipped: "Omitido",
} as const;
export const money = (value: Occurrence["completed"]): string =>
  formatMoneyWithCode({ locale: "es-CO", money: value });
export const expectedAmount = (item: Occurrence): string => {
  if (item.status === "completed") return money(item.completed);
  if (item.plan.money === undefined) return "Por confirmar";
  return `${money(item.plan.money)}${item.plan.amountMode === "estimated" ? " · Estimado" : ""}`;
};
export const monthLabel = (month: string): string =>
  DateTime.format(DateTime.makeUnsafe(`${month}-01`), {
    locale: "es-CO",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
export const shiftMonth = ({ month, step }: Readonly<{ month: string; step: number }>): string =>
  DateTime.formatIsoDateUtc(
    DateTime.add(DateTime.makeUnsafe(`${month}-01`), { months: step })
  ).slice(0, "2026-01".length);

export const planFromTransaction = ({
  transaction,
  timeZone,
}: Readonly<{
  transaction: CanonicalSuccess<"transactions.listTransactions">["data"][number];
  timeZone: PlanInput["timeZone"];
}>): Partial<PlanInput> & Pick<PlanInput, "timeZone"> => ({
  name: Option.getOrElse(transaction.counterparty, () => "Nuevo recurrente"),
  kind: transaction.direction === "inflow" ? "income" : "expense",
  currency: transaction.money.currency,
  money: transaction.money,
  amountMode: "fixed",
  frequency: "monthly",
  timeZone,
  firstDate: DateTime.formatIsoDate(DateTime.makeZonedUnsafe(transaction.occurredAt, { timeZone })),
  categoryId: transaction.categoryId,
  ...Option.match(transaction.counterparty, {
    onNone: () => ({}),
    onSome: (counterparty) => ({ counterparty }),
  }),
});

export const transferLabel = (items: ReadonlyArray<Occurrence>): string => {
  const transfers = items.filter((item) => item.plan.kind === "transfer");
  if (!transfers.some((item) => item.plan.cardPayment === true)) return "Transferencias";
  return transfers.every((item) => item.plan.cardPayment === true)
    ? "Pagos de tarjeta"
    : "Tarjetas y transferencias";
};
