import { Schema, SchemaTransformation } from "effect";

// What `format: "date-time"` promises a caller. Ungated, the parser underneath
// also takes "2026" and "March 14, 2026 GMT", filling the absent date and time
// in silently, and takes an offsetless spelling whose instant a reader can only
// guess at.
const rfc3339 =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

/**
 * The one spelling of a UTC instant: an RFC 3339 date-time string on every
 * boundary, a `DateTime.Utc` in memory. Any offset decodes to the instant it
 * names; encoding always answers in UTC.
 *
 * It carries no description of its own — what tells `occurredAt` from
 * `createdAt` is the field, not the type. The `date-time` format is what travels
 * into derived JSON Schema and OpenAPI.
 */
export const UtcTimestamp = Schema.String.annotate({ format: "date-time" })
  .check(Schema.isPattern(rfc3339))
  .pipe(Schema.decodeTo(Schema.DateTimeUtc, SchemaTransformation.dateTimeUtcFromString))
  .annotate({ identifier: "UtcTimestamp" });
export type UtcTimestamp = typeof UtcTimestamp.Type;
