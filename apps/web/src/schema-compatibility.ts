import { Schema } from "effect";

export const jsonStringSchema = <Source extends Schema.Constraint>(
  schema: Source
): Schema.fromJsonString<Schema.toCodecJson<Source>> =>
  Schema.fromJsonString(Schema.toCodecJson(schema));

export const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
