import { DateTime, Schema, SchemaTransformation } from "effect";

// Require complete offset-bearing RFC 3339 input. Workers AI structured-output
// validators require this JSON Schema pattern to avoid lookaround.
const rfc3339 =
  /^(?:[0-9]{3}[1-9]|[0-9]{2}[1-9][0-9]|[0-9][1-9][0-9]{2}|[1-9][0-9]{3})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?(?:Z|[+-](?:0[0-9]|1[0-5]):[0-5][0-9])$/u;

const monthStart = 5;
const monthEnd = 7;
const dayStart = 8;
const dayEnd = 10;
const gregorianLeapCycle = 400;
const longMonthDays = 31;
const shortMonthDays = 30;
const leapFebruaryDays = 29;
const commonFebruaryDays = 28;

const existingCalendarDate = Schema.makeFilter<string>(
  (value) => {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(monthStart, monthEnd));
    const day = Number(value.slice(dayStart, dayEnd));
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % gregorianLeapCycle === 0);
    const days = [
      longMonthDays,
      leapYear ? leapFebruaryDays : commonFebruaryDays,
      longMonthDays,
      shortMonthDays,
      longMonthDays,
      shortMonthDays,
      longMonthDays,
      longMonthDays,
      shortMonthDays,
      longMonthDays,
      shortMonthDays,
      longMonthDays,
    ];
    return day <= (days[month - 1] ?? 0) || "Expected an existing calendar date";
  },
  {
    toJsonSchema: () => [{}, true],
  }
);

const canonicalUtcDateTime = Schema.DateTimeUtc.check(
  Schema.makeIsBetween({ order: DateTime.Order })({
    minimum: DateTime.makeUnsafe("0001-01-01T00:00:00.000Z"),
    maximum: DateTime.makeUnsafe("9999-12-31T23:59:59.999Z"),
  })
);

/**
 * RFC 3339 instant with a four-digit year from 0001 through 9999 and `Z` or an
 * offset from -15:59 through +15:59. Decoding resolves the UTC instant; encoding
 * always uses UTC.
 */
export const UtcTimestamp = Schema.String.annotate({ format: "date-time" })
  .check(Schema.isPattern(rfc3339), existingCalendarDate)
  .annotate({ identifier: "UtcTimestamp" })
  .pipe(Schema.decodeTo(canonicalUtcDateTime, SchemaTransformation.dateTimeUtcFromString))
  .annotate({ identifier: "UtcTimestamp" });
export type UtcTimestamp = typeof UtcTimestamp.Type;
