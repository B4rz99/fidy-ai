import { Schema, Struct } from "effect";
import { CategoryId } from "./reference";

/** Stable identity of one user keyword rule; tie-breaking may rely on its lexical UUID order. */
export const KeywordRuleId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("KeywordRuleId")
);
export type KeywordRuleId = typeof KeywordRuleId.Type;

/** Spanish label shown for a Category; changing it never changes Category identity. */
export const CategoryLabel = Schema.NonEmptyString.check(Schema.isTrimmed())
  .check(Schema.isMaxLength(80))
  .pipe(Schema.brand("CategoryLabel"));
export type CategoryLabel = typeof CategoryLabel.Type;

/** Normalizes a merchant fragment for case- and diacritic-insensitive comparison. */
export const normalizeCategoryKeyword = (value: string): string =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-CO");

/** User-authored merchant fragment retained with its spelling but normalized only while matching. */
export const CategoryKeyword = Schema.NonEmptyString.check(Schema.isTrimmed())
  .check(Schema.isMaxLength(80))
  .check(
    Schema.makeFilter((keyword) =>
      normalizeCategoryKeyword(keyword).length > 0
        ? undefined
        : { path: [], issue: "Expected a keyword containing a letter or number" }
    )
  )
  .pipe(Schema.brand("CategoryKeyword"));
export type CategoryKeyword = typeof CategoryKeyword.Type;

/** Public Category metadata; identity remains stable when its Spanish label changes. */
export const Category = Schema.Struct({
  id: CategoryId,
  label: CategoryLabel,
}).annotate({ identifier: "Category" });
export type Category = typeof Category.Type;

/** One User-owned instruction assigning matching future captures to a Category. */
export const KeywordRule = Schema.Struct({
  id: KeywordRuleId,
  keyword: CategoryKeyword,
  categoryId: CategoryId,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
}).annotate({ identifier: "KeywordRule" });
export type KeywordRule = typeof KeywordRule.Type;

/** Facts a caller supplies for a new rule; identity and timestamps are assigned at persistence. */
export const CreateKeywordRuleInput = KeywordRule.mapFields(
  Struct.omit(["id", "createdAt", "updatedAt"])
).annotate({ identifier: "CreateKeywordRuleInput" });
export type CreateKeywordRuleInput = typeof CreateKeywordRuleInput.Type;

/** Complete replacement of a rule's editable keyword and target Category. */
export const UpdateKeywordRuleInput = CreateKeywordRuleInput.annotate({
  identifier: "UpdateKeywordRuleInput",
});
export type UpdateKeywordRuleInput = typeof UpdateKeywordRuleInput.Type;
