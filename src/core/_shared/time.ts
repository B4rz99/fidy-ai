import { DateTime, Schema, SchemaTransformation } from "effect";

// What `format: "date-time"` promises a caller. Ungated, the parser underneath
// also takes "2026" and "March 14, 2026 GMT", filling the absent date and time
// in silently, and takes an offsetless spelling whose instant a reader can only
// guess at.
const rfc3339 =
  /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/u;

const canonicalUtcDateTime = Schema.DateTimeUtc.check(
  Schema.makeIsBetween({ order: DateTime.Order })({
    minimum: DateTime.makeUnsafe("0001-01-01T00:00:00.000Z"),
    maximum: DateTime.makeUnsafe("9999-12-31T23:59:59.999Z"),
  })
);

/**
 * The portable spelling of a UTC instant: an RFC 3339 date-time string with a four-digit
 * year from 0001 through 9999 and either `Z` or a numeric offset from -15:59 through
 * +15:59. A valid offset decodes to its named `DateTime.Utc` instant; encoding always
 * answers in UTC.
 *
 * It carries no description of its own — what tells `occurredAt` from
 * `createdAt` is the field, not the type. The `date-time` format is what travels
 * into derived JSON Schema and OpenAPI.
 */
export const UtcTimestamp = Schema.String.annotate({ format: "date-time" })
  .check(Schema.isPattern(rfc3339))
  .pipe(Schema.decodeTo(canonicalUtcDateTime, SchemaTransformation.dateTimeUtcFromString))
  .annotate({ identifier: "UtcTimestamp" });
export type UtcTimestamp = typeof UtcTimestamp.Type;
