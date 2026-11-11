import { observeRecurringPlan } from "@fidy/server/recurring-plan-decisions";
import { DateTime, Effect, Option } from "effect";
import type { CanonicalInput, CanonicalSuccess } from "@/transport/client";
import { formatMoneyWithCode } from "@/transport/money";

export type WorkspaceReadState = "current" | "refreshing" | "stale";
export type Workspace = CanonicalSuccess<"recurringPlans.getRecurringWorkspace">["data"];
export type Occurrence = Workspace["occurrences"][number];
export type Plan = Workspace["document"]["plans"][number];
export type PlanInput = Plan["revisions"][number]["plan"];
export type Edit = CanonicalInput<"recurringPlans.applyRecurringEdit">["payload"]["edit"];
export type Filters = Omit<
  CanonicalInput<"recurringPlans.getRecurringWorkspace">["query"],
  "month" | "previousMonth" | "view"
>;
export type Category = CanonicalSuccess<"categories.listCategories">["data"][number];
export type Save = (edit: Edit, onSaved?: () => void) => void;
export type CreationReceipt = Readonly<{ planId: Plan["id"]; date: string; transactionId: string }>;
export type CreationResultProps = Readonly<{
  receipt: CreationReceipt;
  minimumRevision: Workspace["document"]["revision"];
  categories: ReadonlyArray<Category>;
  disabled: boolean;
  save: Save;
  close: () => void;
}>;
export const planToday = (plan: Plan): string => {
  const now = DateTime.nowUnsafe();
  const revision =
    plan.revisions.findLast(
      (entry) =>
        entry.from <=
        DateTime.formatIsoDate(DateTime.makeZonedUnsafe(now, { timeZone: entry.plan.timeZone }))
    ) ?? plan.revisions[0];
  return DateTime.formatIsoDate(
    DateTime.makeZonedUnsafe(now, { timeZone: revision.plan.timeZone })
  );
};
export const currentPlan = (plan: Plan): PlanInput => {
  const date = planToday(plan);
  return (plan.revisions.findLast((entry) => entry.from <= date) ?? plan.revisions[0]).plan;
};
export const planStatus = (plan: Plan): "scheduled" | "stopped" | "paused" | "active" =>
  Option.getOrThrow(
    Effect.runSync(
      observeRecurringPlan({
        document: { plans: [plan], exceptions: [], fulfillments: [], excludedTransactionIds: [] },
        planId: plan.id,
        date: planToday(plan),
      })
    )
  ).status;
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
