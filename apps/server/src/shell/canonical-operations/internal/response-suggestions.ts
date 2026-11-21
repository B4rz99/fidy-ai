import { Array as Arr, Option, Predicate, Schema } from "effect";
import type { CatalogOperation, OperationCatalog } from "~/shell/canonical-catalog/contract";
import { SuggestedOperation } from "~/shell/public-http/contract";

export type ResponseSuggestionsInput = Readonly<{
  value: Schema.Json;
  catalog: OperationCatalog;
  available: (operation: CatalogOperation) => boolean;
}>;

type Scope = Omit<ResponseSuggestionsInput, "value">;

const EncodedSuggestion = Schema.toEncoded(SuggestedOperation);

const isJsonScalar = Predicate.or(
  Predicate.or(Predicate.isNull, Predicate.isString),
  Predicate.or(Predicate.isNumber, Predicate.isBoolean)
);

const permittedReference = (value: Option.Option<Schema.Json>, scope: Scope): boolean =>
  Option.match(value, {
    onNone: () => true,
    onSome: (reference) => {
      if (!Predicate.isString(reference)) return true;
      const target = scope.catalog.byId.get(reference);

      return target === undefined || scope.available(target);
    },
  });

const hintedReferencesAvailable = (value: Schema.Json, scope: Scope): boolean => {
  if (Arr.isArray<Schema.Json>(value)) {
    return value.every((child) => hintedReferencesAvailable(child, scope));
  }

  if (isJsonScalar(value)) return true;

  return (
    permittedReference(Option.fromUndefinedOr(value.tool), scope) &&
    permittedReference(Option.fromUndefinedOr(value.operation), scope) &&
    Object.values(value).every((child) => hintedReferencesAvailable(child, scope))
  );
};

const isCanonicalSuggestion = (value: Readonly<Record<string, Schema.Json>>): boolean =>
  Predicate.isString(value.tool) &&
  Predicate.isString(value.hint) &&
  Option.isSome(Schema.decodeUnknownOption(EncodedSuggestion)(value));

const project = (value: Schema.Json, scope: Scope): Option.Option<Schema.Json> => {
  if (Arr.isArray<Schema.Json>(value)) {
    return Option.some(
      value.flatMap((child) =>
        Option.match(project(child, scope), { onNone: () => [], onSome: (kept) => [kept] })
      )
    );
  }

  if (isJsonScalar(value)) return Option.some(value);

  if (isCanonicalSuggestion(value) && !hintedReferencesAvailable(value, scope)) {
    return Option.none();
  }

  return Option.some(
    Object.fromEntries(
      Object.entries(value).flatMap(([name, child]) =>
        Option.match(project(child, scope), { onNone: () => [], onSome: (kept) => [[name, kept]] })
      )
    )
  );
};

export const responseSuggestions = ({ value, ...scope }: ResponseSuggestionsInput): Schema.Json =>
  Option.getOrElse(project(value, scope), () => null);
