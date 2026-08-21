import { Option, Predicate } from "effect";
import type { Schema } from "effect";

/**
 * The one canonical JSON text behind hosted input identity. Key order carries no meaning in JSON,
 * so both the confirmation digest and the permit ledger must derive their key the same way or a
 * confirmed call could fail to match the permit it was issued.
 */
export const canonicalJsonString = (value: Schema.Json): string =>
  Option.getOrThrow(
    Option.fromNullishOr(
      JSON.stringify(value, (_key, nested: unknown) =>
        Predicate.isObject(nested)
          ? Object.fromEntries(
              Object.entries(nested).toSorted(([left], [right]) => left.localeCompare(right))
            )
          : nested
      )
    )
  );
