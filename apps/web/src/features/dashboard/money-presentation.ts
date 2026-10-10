import { BigDecimal, Option, Schema } from "effect";
import type { CanonicalSuccess } from "@/transport/client";

export { formatCurrencyAmount, formatMoney } from "@/transport/money";

type DashboardView = CanonicalSuccess<"dashboard.getDashboardView">["data"];
type DashboardWidget = Extract<DashboardView["layout"], { readonly kind: "leaf" }>["widget"];
type MetricResult = Extract<DashboardWidget["result"], { readonly moneyGroups: unknown }>;
type PresentableMoney = MetricResult["moneyGroups"][number]["inflow"];

const InflowChartPayload = Schema.Struct({ inflowExact: Schema.String });
const OutflowChartPayload = Schema.Struct({ outflowExact: Schema.String });

/** Reads authoritative tooltip text only from the exact row payload; malformed payloads stay absent. */
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

/** Preserves canonical decimal text without passing through a binary number. */
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

/** Returns private bounded dimensionless geometry; authoritative labels continue to use Money. */
export const moneyProgressGeometry = ({
  spent,
  cap,
}: Readonly<{ spent: PresentableMoney; cap: PresentableMoney }>): number =>
  boundedRatio(spent.amount, cap.amount) * 100;

/** Scales a Currency series to finite [0, 1] geometry while retaining exact values separately. */
export const moneySeriesGeometry = (
  amounts: ReadonlyArray<Readonly<BigDecimal.BigDecimal>>
): ReadonlyArray<number> => {
  const maximum = amounts.reduce(
    (current, amount) => (BigDecimal.isGreaterThan(amount, current) ? amount : current),
    BigDecimal.make(0n, 0)
  );
  return amounts.map((amount) => boundedRatio(amount, maximum));
};
