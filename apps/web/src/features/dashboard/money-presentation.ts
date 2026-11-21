import { BigDecimal, Option, Schema } from "effect";
import type { CanonicalSuccess } from "@/transport/client";

export { formatCurrencyAmount, formatMoney } from "@/transport/money";

type DashboardView = CanonicalSuccess<"dashboard.getDashboardView">["data"];

type DashboardWidget = Extract<DashboardView["layout"], { readonly kind: "leaf" }>["widget"];

type MetricResult = Extract<DashboardWidget["result"], { readonly moneyGroups: unknown }>;

type PresentableMoney = MetricResult["moneyGroups"][number]["inflow"];

const InflowChartPayload = Schema.Struct({ inflowExact: Schema.String });

const OutflowChartPayload = Schema.Struct({ outflowExact: Schema.String });

export const exactChartAmount = ({
  payload,
  series,
}: Readonly<{
  payload: unknown;
  series: "inflow" | "outflow";
}>): Option.Option<string> =>
  series === "inflow"
    ? Option.map(Schema.decodeUnknownOption(InflowChartPayload)(payload), (row) => row.inflowExact)
    : Option.map(
        Schema.decodeUnknownOption(OutflowChartPayload)(payload),
        (row) => row.outflowExact
      );

export const moneyDecimalText = (money: PresentableMoney): string =>
  BigDecimal.format(money.amount);

const boundedRatio = (
  numerator: Readonly<BigDecimal.BigDecimal>,
  denominator: Readonly<BigDecimal.BigDecimal>
): number => {
  if (BigDecimal.isZero(denominator) || BigDecimal.isNegative(numerator)) return 0;
  const bounded = BigDecimal.isGreaterThan(numerator, denominator) ? denominator : numerator;

  return Number(BigDecimal.format(BigDecimal.divideUnsafe(bounded, denominator)));
};

export const moneyProgressGeometry = ({
  spent,
  cap,
}: Readonly<{ spent: PresentableMoney; cap: PresentableMoney }>): number =>
  boundedRatio(spent.amount, cap.amount) * 100;

export const moneySeriesGeometry = (
  amounts: ReadonlyArray<Readonly<BigDecimal.BigDecimal>>
): ReadonlyArray<number> => {
  const maximum = amounts.reduce(
    (current, amount) => (BigDecimal.isGreaterThan(amount, current) ? amount : current),
    BigDecimal.make(0n, 0)
  );

  return amounts.map((amount) => boundedRatio(amount, maximum));
};

export const moneyUtilizationLabel = ({
  spent,
  cap,
}: Readonly<{ spent: PresentableMoney; cap: PresentableMoney }>): Option.Option<string> => {
  if (BigDecimal.isZero(cap.amount)) return Option.none();

  const percent = BigDecimal.multiply(
    BigDecimal.divideUnsafe(spent.amount, cap.amount),
    BigDecimal.make(100n, 0)
  );

  return Option.some(`${BigDecimal.format(BigDecimal.round(percent, { scale: 0 }))} % utilizado`);
};
