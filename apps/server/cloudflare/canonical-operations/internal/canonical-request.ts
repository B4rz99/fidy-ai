import { Option, Schema } from "effect";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";

const requestParts = Schema.Struct({
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  query: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.NullOr(Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]))
    )
  ),
});

type RequestInput = Readonly<{ operation: CatalogOperation; input: Schema.Json }>;
const decodeRequestParts = ({
  operation,
  input,
}: RequestInput): Option.Option<typeof requestParts.Type> =>
  Schema.decodeUnknownOption(requestParts)(input).pipe(
    Option.filter(
      (parts) =>
        !Object.values(parts.query ?? {}).includes(null) ||
        Option.isSome(Schema.decodeOption(operation.input)(input))
    )
  );

/** Build only a catalog-owned route from validated canonical arguments, never an arbitrary destination. */
export const requestFor = ({ operation, input }: RequestInput): Option.Option<Request> => {
  const parts = decodeRequestParts({ operation, input });
  if (Option.isNone(parts)) return Option.none();
  const query = parts.value.query ?? {};
  let route = operation.route;
  for (const [key, value] of Object.entries(parts.value.params ?? {})) {
    route = route.replace(`:${key}`, encodeURIComponent(value));
  }
  if (route.includes(":")) return Option.none();
  const url = new URL(route, "https://canonical.internal");
  for (const [key, value] of Object.entries(query)) {
    if (value !== null) url.searchParams.set(key, String(value));
  }
  return Option.some(new Request(url, { method: operation.method }));
};
