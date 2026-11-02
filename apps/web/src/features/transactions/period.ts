import { DateTime, Option, Schema } from "effect";
import { type CurrentMonthPeriod, deriveCurrentMonthPeriod } from "./presentation";

const monthWidth = "YYYY-MM".length;
export const TransactionMonth = Schema.String.check(
  Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/u),
  Schema.makeFilter((month) => month >= "0002-01" && month <= "9998-12")
);
const TransactionDay = Schema.String.check(
  Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u),
  Schema.makeFilter((date) =>
    Option.exists(
      DateTime.make(`${date}T12:00:00Z`),
      (value) =>
        DateTime.formatIsoDateUtc(value) === date &&
        Schema.is(TransactionMonth)(date.slice(0, monthWidth))
    )
  )
);
export const TransactionSearch = Schema.Struct({
  month: Schema.optionalKey(TransactionMonth),
  date: Schema.optionalKey(TransactionDay),
}).check(
  Schema.makeFilter(
    ({ month, date }) => month === undefined || date === undefined || date.startsWith(`${month}-`)
  )
);
export type TransactionSearch = typeof TransactionSearch.Type;

export const selectedTransactionPeriod = ({
  search,
  now,
  timeZone,
}: Readonly<{
  search: TransactionSearch;
  now: DateTime.Utc;
  timeZone: string;
}>): CurrentMonthPeriod => {
  const date = search.date ?? (search.month === undefined ? undefined : `${search.month}-01`);
  return deriveCurrentMonthPeriod({
    now:
      date === undefined
        ? now
        : DateTime.toUtc(
            DateTime.makeZonedUnsafe(`${date}T12:00:00Z`, {
              timeZone,
              adjustForTimeZone: true,
            })
          ),
    timeZone,
  });
};
export const transactionMonth = (period: CurrentMonthPeriod): string =>
  DateTime.formatIsoDate(
    DateTime.setZone(period.from, DateTime.zoneMakeNamedUnsafe(period.timeZone))
  ).slice(0, monthWidth);

export const shiftTransactionMonth = ({
  month,
  offset,
}: Readonly<{ month: string; offset: number }>): string =>
  DateTime.formatIsoDateUtc(
    DateTime.add(DateTime.makeUnsafe(`${month}-01T12:00:00Z`), { months: offset })
  ).slice(0, monthWidth);
