import { Schema, SchemaTransformation } from "effect";

/**
 * The one spelling of a UTC instant: an ISO 8601 date-time string on every
 * boundary, a `DateTime.Utc` in memory. Any offset decodes to the instant it
 * names; encoding always answers in UTC.
 *
 * It carries no description of its own — what tells `occurredAt` from
 * `createdAt` is the field, not the type. The `date-time` format is what travels
 * into derived JSON Schema and OpenAPI.
 */
export const UtcTimestamp = Schema.String.annotate({ format: "date-time" })
  .pipe(Schema.decodeTo(Schema.DateTimeUtc, SchemaTransformation.dateTimeUtcFromString))
  .annotate({ identifier: "UtcTimestamp" });
export type UtcTimestamp = typeof UtcTimestamp.Type;
