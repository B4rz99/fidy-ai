import { Schema } from "effect";

/** Derives a JSON-string boundary that preserves the declaration's exact JSON codec. */
export const jsonStringSchema = <Source extends Schema.Constraint>(
  schema: Source
): Schema.fromJsonString<Schema.toCodecJson<Source>> =>
  Schema.fromJsonString(Schema.toCodecJson(schema));

/** Decodes and encodes arbitrary JSON text without imposing a narrower declaration. */
export const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
