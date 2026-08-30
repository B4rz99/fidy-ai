import { Schema } from "effect";

/** Constructs schema-serializable yieldable failures. */
export const SchemaSerializableError = Schema.Error;

/** Constructs schema-serializable yieldable failures with an encoded `_tag`. */
export const TaggedSerializableError = Schema.TaggedError;

/**
 * Derives a JSON-string boundary from a schema's JSON codec. Callers may rely on exact JSON text
 * encoding for declarations such as BigDecimal rather than passing decoded runtime values to JSON.
 */
export const jsonStringSchema = <Source extends Schema.Constraint>(
  schema: Source
): Schema.fromJsonString<Schema.toCodecJson<Source>> =>
  Schema.fromJsonString(Schema.toCodecJson(schema));

/** Decodes and encodes an arbitrary value at a JSON-string boundary. */
export const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
