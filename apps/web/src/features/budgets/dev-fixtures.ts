import { BigDecimal } from "effect";
import {
  Budget as BudgetSchema,
  BudgetStatusReport,
  Category as CategorySchema,
  Currency,
} from "@/transport/client";
import type { WorkspaceProps } from "./model";
import type { BudgetReport, BudgetStatus, Category } from "./presentation";

export type PreviewDataset = "demo" | "worst" | "empty" | "one" | "full" | "many";
const uuidSuffixLength = 12;
const worstRowCount = 8;
const manyRowCount = 1000;
const fixtureCount = (dataset: PreviewDataset, total: number): number => {
  if (dataset === "one") return 1;
  return dataset === "worst" ? worstRowCount : total;
};
const groupLimitName = "Mantenimiento y administración de propiedades familiares rurales";
const labels = [
  "Restaurantes y celebraciones familiares con invitados internacionales y catering",
  "SeguroResponsabilidadCivilProfesionalInternacionalRenovaciónAnual",
  "Á",
  "家庭日用品・教育費・海外旅行の積立",
  "👨‍👩‍👧‍👦 Alimentación, educación y cuidados familiares",
  "Servicios",
  "Servicios",
  "Créditos & seguros <anuales>",
];
const amountCases = [
  ["9876543210.99", "10000000000.01"],
  ["123456789.90", "0"],
  ["0.01", "0.01"],
  ["250", "124.75"],
  ["100", "140"],
];

const fixtureCategory = (category: Category, index: number, worst: boolean): Category =>
  CategorySchema.make({
    ...category,
    label: CategorySchema.fields.label.make(
      worst ? (labels[index % labels.length] ?? category.label) : category.label
    ),
  });

const fixtureCurrency = (index: number): Currency => {
  if (index === 2) return Currency.make("JPY");
  if (index === 4) return Currency.make("KWD");
  if (index < 2 || index % 3 === 0) return Currency.make("COP");
  return Currency.make(index % 3 === 1 ? "USD" : "EUR");
};
const fixtureAmounts = (
  index: number,
  worst: boolean
): Readonly<{ cap: BudgetStatus["budget"]["cap"]; spent: BudgetStatus["spent"] }> => {
  const selected = amountCases[index % amountCases.length] ?? ["100", "0"];
  const amounts = index === 2 ? ["1", "1"] : selected;
  const currency = fixtureCurrency(index);
  return {
    cap: {
      currency,
      amount: BigDecimal.fromStringUnsafe(worst ? (amounts[0] ?? "100") : "100000"),
    },
    spent: { currency, amount: BigDecimal.fromStringUnsafe(worst ? (amounts[1] ?? "0") : "50000") },
  };
};
const fixtureStatus = ({
  period,
  category,
  index,
  worst,
}: Readonly<{
  period: BudgetReport["period"];
  category: Category;
  index: number;
  worst: boolean;
}>): BudgetStatus => {
  const { cap, spent } = fixtureAmounts(index, worst);
  const currency = cap.currency;
  const difference = BigDecimal.subtract(cap.amount, spent.amount);
  const common = {
    period,
    budget: {
      createdAt: period.from,
      updatedAt: period.from,
      id: BudgetSchema.fields.id.make(
        `24000000-0000-4000-8000-${String(index + 1).padStart(uuidSuffixLength, "0")}`
      ),
      categoryId: category.id,
      cap,
      ...(worst && index === worstRowCount - 1
        ? {}
        : { groupName: worst && index < 2 ? groupLimitName : `Grupo ${index + 1}` }),
    },
    spent,
  };
  if (BigDecimal.isNegative(difference)) {
    return { ...common, type: "over", overBy: { currency, amount: BigDecimal.negate(difference) } };
  }
  if (BigDecimal.isZero(difference)) return { ...common, type: "reached" };
  return { ...common, type: "under", remaining: { currency, amount: difference } };
};

const manyStatuses = (props: WorkspaceProps): ReadonlyArray<BudgetStatus> =>
  Array.from({ length: manyRowCount }, (_, index) => {
    const category = props.categories[index % props.categories.length];
    if (category === undefined) throw new Error("Stress fixture requires the canonical taxonomy");
    const status = fixtureStatus({ period: props.report.period, category, index, worst: false });
    const currency = Currency.make(
      Currency.literals[Math.floor(index / props.categories.length)] ?? "COP"
    );
    return {
      ...status,
      type: "under",
      budget: {
        ...status.budget,
        groupName: `Presupuesto ${currency}`,
        cap: { ...status.budget.cap, currency },
      },
      spent: { ...status.spent, currency },
      remaining: { currency, amount: BigDecimal.fromStringUnsafe("50000") },
    };
  });
const cashFlowExpenses = (
  statuses: ReadonlyArray<BudgetStatus>
): BudgetReport["cashFlow"]["expenses"] =>
  [...new Set(statuses.map((status) => status.spent.currency))].map((currency) => ({
    currency,
    amount: BigDecimal.sumAll(
      statuses
        .filter((status) => status.spent.currency === currency)
        .map((status) => status.spent.amount)
    ),
  }));
/** Local presentation-only fixtures; no command is authorized by this boundary. */
export const previewProps = ({
  props,
  dataset,
}: Readonly<{ props: WorkspaceProps; dataset: PreviewDataset }>): WorkspaceProps => {
  if (dataset === "demo") return props;
  const categories =
    dataset === "empty"
      ? []
      : (dataset === "one" ? props.categories.slice(0, 1) : props.categories).map(
          (category, index) => fixtureCategory(category, index, dataset === "worst")
        );
  const count = fixtureCount(dataset, categories.length);
  const standardStatuses = categories
    .slice(0, count)
    .map((category, index) =>
      fixtureStatus({ period: props.report.period, category, index, worst: dataset === "worst" })
    );
  const statuses = dataset === "many" ? manyStatuses(props) : standardStatuses;
  const report: BudgetReport = BudgetStatusReport.make({
    ...props.report,
    statuses,
    cashFlow: {
      income:
        dataset === "empty"
          ? []
          : [
              {
                currency: Currency.make("COP"),
                amount: BigDecimal.fromStringUnsafe(
                  dataset === "worst" ? "30000000000.99" : "6200000"
                ),
              },
            ],
      expenses: cashFlowExpenses(statuses),
    },
  });
  return {
    ...props,
    categories,
    report,
    budgets: statuses.map((status) => status.budget),
    editable: false,
    onRefresh: (): void => undefined,
  };
};
