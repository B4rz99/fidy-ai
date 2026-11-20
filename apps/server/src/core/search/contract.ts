import { Schema, SchemaTransformation } from "effect";

export const NormalizedSearchText = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (value) =>
        value
          .normalize("NFD")
          .replaceAll(/[\u0300-\u036f]/g, "")
          .toLocaleLowerCase("es-CO"),
      encode: (value) => value,
    })
  )
);
