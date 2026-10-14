import { BigDecimal } from "effect";
import type { CanonicalSuccess } from "@/transport/client";
import { formatMoney } from "@/transport/money";

export type Budget = CanonicalSuccess<"budgets.listBudgets">["data"][number];
export type BudgetReport = CanonicalSuccess<"budgets.getBudgetStatus">["data"];
export type BudgetStatus = BudgetReport["statuses"][number];
export type Category = CanonicalSuccess<"categories.listCategories">["data"][number];
export type CurrentUser = CanonicalSuccess<"identity.getCurrentUser">["data"];

/** Defaults organize presentation without changing canonical Category identities. */
export const defaultBudgetGroup = (label: string): string => {
  if (["Vivienda", "Servicios"].includes(label)) return "Hogar";
  if (["Restaurantes", "Domicilios", "Mercado"].includes(label)) return "Alimentación";
  if (["Transporte", "Viajes"].includes(label)) return "Movilidad";
  if (["Salud", "Educación"].includes(label)) return "Bienestar";
  return "Otros gastos";
};

export const budgetRemaining = (status: BudgetStatus): BigDecimal.BigDecimal =>
  BigDecimal.subtract(status.budget.cap.amount, status.spent.amount);

/** The display ratio is approximate; all monetary totals retain exact decimals. */
export const budgetPercentage = ({
  cap,
  spent,
}: Readonly<{
  cap: Readonly<BigDecimal.BigDecimal>;
  spent: Readonly<BigDecimal.BigDecimal>;
}>): number =>
  Math.min(
    100,
    Math.max(
      0,
      BigDecimal.toNumberUnsafe(
        BigDecimal.multiply(BigDecimal.divideUnsafe(spent, cap), BigDecimal.make(100n, 0))
      )
    )
  );

export const budgetFigures = ({
  statuses,
  locale,
}: Readonly<{ statuses: ReadonlyArray<BudgetStatus>; locale: string }>): ReadonlyArray<
  Readonly<{
    currency: Budget["cap"]["currency"];
    budgeted: string;
    spent: string;
    remaining: string;
    over: boolean;
    percentage: number;
  }>
> =>
  [...new Set(statuses.map((status) => status.budget.cap.currency))].sort().map((currency) => {
    const selected = statuses.filter((status) => status.budget.cap.currency === currency);
    const cap = BigDecimal.sumAll(selected.map((status) => status.budget.cap.amount));
    const spent = BigDecimal.sumAll(selected.map((status) => status.spent.amount));
    const remaining = BigDecimal.subtract(cap, spent);
    const format = (amount: BigDecimal.BigDecimal): string =>
      formatMoney({ locale, money: { amount, currency } });
    return {
      currency,
      budgeted: format(cap),
      spent: format(spent),
      remaining: format(remaining),
      over: BigDecimal.isNegative(remaining),
      percentage: budgetPercentage({ cap, spent }),
    };
  });

export type SummaryFigure = Readonly<{
  currency: Budget["cap"]["currency"];
  income: string;
  expenses: string;
  budgeted: string;
  balance: string;
  unallocated: string;
  overallocated: boolean;
  allocationAmount: string;
  remaining: string;
  over: boolean;
  percentage: number;
}>;

/** Monthly cash flow includes uncapped categories and never mixes currencies. */
export const summaryFigures = ({
  report,
  locale,
}: Readonly<{ report: BudgetReport; locale: string }>): ReadonlyArray<SummaryFigure> =>
  [
    ...new Set([
      ...report.statuses.map((status) => status.budget.cap.currency),
      ...report.cashFlow.income.map((money) => money.currency),
      ...report.cashFlow.expenses.map((money) => money.currency),
    ]),
  ]
    .sort()
    .map((currency) => {
      const income = BigDecimal.sumAll(
        report.cashFlow.income
          .filter((money) => money.currency === currency)
          .map((money) => money.amount)
      );
      const expenses = BigDecimal.sumAll(
        report.cashFlow.expenses
          .filter((money) => money.currency === currency)
          .map((money) => money.amount)
      );
      const cap = BigDecimal.sumAll(
        report.statuses
          .filter((status) => status.budget.cap.currency === currency)
          .map((status) => status.budget.cap.amount)
      );
      const remaining = BigDecimal.subtract(cap, expenses);
      const format = (amount: BigDecimal.BigDecimal): string =>
        formatMoney({ locale, money: { currency, amount } });
      return {
        currency,
        income: format(income),
        expenses: format(expenses),
        budgeted: format(cap),
        balance: format(BigDecimal.subtract(income, expenses)),
        unallocated: format(BigDecimal.subtract(income, cap)),
        overallocated: BigDecimal.isGreaterThan(cap, income),
        allocationAmount: format(BigDecimal.abs(BigDecimal.subtract(income, cap))),
        remaining: format(remaining),
        over: BigDecimal.isNegative(remaining),
        percentage: BigDecimal.isZero(cap) ? 0 : budgetPercentage({ cap, spent: expenses }),
      };
    });
