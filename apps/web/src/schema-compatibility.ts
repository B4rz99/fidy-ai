import { Schema } from "effect";

/** Derives a JSON-string boundary that preserves a schema's exact JSON-encoded values. */
export const jsonStringSchema = <Source extends Schema.Constraint>(
  schema: Source
): Schema.fromJsonString<Schema.toCodecJson<Source>> =>
  Schema.fromJsonString(Schema.toCodecJson(schema));

/** Decodes and encodes an arbitrary value at a JSON-string boundary. */
export const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
