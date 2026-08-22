import type { CanonicalSuccess } from "@/transport/client";
import { BigDecimal, DateTime, Option, Schema } from "effect";

/** Canonical values remain derived from FidyApi rather than redeclared by the browser. */
export type CurrentUser = CanonicalSuccess<"identity.getCurrentUser">["data"];
export type Category = CanonicalSuccess<"categories.listCategories">["data"][number];
export type Transaction = CanonicalSuccess<"transactions.listTransactions">["data"][number];

/** Half-open UTC bounds for one calendar month in the exact applied IANA time zone. */
export type CurrentMonthPeriod = Readonly<{
  from: DateTime.Utc;
  to: DateTime.Utc;
  timeZone: string;
}>;

/** Derives the User's local calendar month without allowing Locale to affect query instants. */
export const deriveCurrentMonthPeriod = ({
  now,
  timeZone,
}: Readonly<{
  now: DateTime.Utc;
  timeZone: string;
}>): CurrentMonthPeriod => {
  const zonedNow = DateTime.setZone(now, DateTime.zoneMakeNamedUnsafe(timeZone));
  const zonedFrom = DateTime.startOf(zonedNow, "month");
  return {
    from: DateTime.toUtc(zonedFrom),
    to: DateTime.toUtc(DateTime.add(zonedFrom, { months: 1 })),
    timeZone,
  };
};

const StringNumericLiteral = Schema.TemplateLiteral([Schema.Finite]);

/** Formats exact canonical Money with the User's Locale and the Money's explicit Currency. */
export const formatMoney = ({
  locale,
  money,
}: Readonly<{
  locale: string;
  money: Transaction["money"];
}>): string =>
  new Intl.NumberFormat(locale, {
    currency: money.currency,
    currencyDisplay: "code",
    style: "currency",
  }).format(Schema.decodeUnknownSync(StringNumericLiteral)(BigDecimal.format(money.amount)));

/** Presentation-only projection consumed by both desktop and mobile Transaction views. */
export type TransactionListRow = Readonly<{
  id: string;
  categoryLabel: string;
  counterpartyLabel: string;
  direction: Transaction["direction"];
  directionLabel: "Ingreso" | "Salida";
  moneyText: string;
  occurredOnText: string;
}>;

const formatOccurrence = ({
  locale,
  occurredAt,
  timeZone,
}: Readonly<{
  locale: string;
  occurredAt: Transaction["occurredAt"];
  timeZone: string;
}>): string =>
  new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone,
    year: "numeric",
  }).format(occurredAt.epochMilliseconds);

export type TransactionPresentationCategory = Readonly<{
  id: string;
  label: string;
}>;

export type TransactionPresentationRecord = Readonly<{
  id: string;
  money: Transaction["money"];
  counterparty: Transaction["counterparty"];
  direction: Transaction["direction"];
  categoryId: string;
  occurredAt: Transaction["occurredAt"];
}>;

/** Joins canonical records while preserving the canonical newest-first Transaction order. */
export const presentTransactionRows = ({
  categories,
  counterpartyFallback,
  locale,
  timeZone,
  transactions,
}: Readonly<{
  categories: ReadonlyArray<TransactionPresentationCategory>;
  counterpartyFallback: string;
  locale: string;
  timeZone: string;
  transactions: ReadonlyArray<TransactionPresentationRecord>;
}>): ReadonlyArray<TransactionListRow> => {
  const categoryLabels = new Map(categories.map(({ id, label }) => [id, label]));
  return transactions.map((transaction) => ({
    id: transaction.id,
    categoryLabel: categoryLabels.get(transaction.categoryId) ?? "Categoría no disponible",
    counterpartyLabel: Option.getOrElse(transaction.counterparty, () => counterpartyFallback),
    direction: transaction.direction,
    directionLabel: transaction.direction === "inflow" ? "Ingreso" : "Salida",
    moneyText: formatMoney({ locale, money: transaction.money }),
    occurredOnText: formatOccurrence({ locale, occurredAt: transaction.occurredAt, timeZone }),
  }));
};

/** Presents the month while retaining the exact IANA zone used to derive its query bounds. */
export const presentPeriod = ({
  locale,
  period: { from, timeZone },
}: Readonly<{
  locale: string;
  period: CurrentMonthPeriod;
}>): Readonly<{
  monthLabel: string;
  timeZone: string;
}> => ({
  monthLabel: new Intl.DateTimeFormat(locale, {
    month: "long",
    timeZone,
    year: "numeric",
  }).format(from.epochMilliseconds),
  timeZone,
});
