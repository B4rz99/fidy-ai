import { Schema } from "effect";

/** Decodes a native PostgreSQL bigint into a finite JavaScript number. */
export const FiniteFromBigInt = Schema.flip(Schema.BigIntFromString).pipe(
  Schema.decodeTo(Schema.FiniteFromString)
);

/** Derives a JSON-string boundary that preserves the declaration's exact JSON codec. */
export const jsonStringSchema = <Source extends Schema.Constraint>(
  schema: Source
): Schema.fromJsonString<Schema.toCodecJson<Source>> =>
  Schema.fromJsonString(Schema.toCodecJson(schema));

/** Decodes and encodes arbitrary JSON text without imposing a narrower declaration. */
export const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
