import { Data, Schema, Struct } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";

/**
 * Stable identity of a Category, independent of its label, display order, and taxonomy version.
 * Any slice may retain this value without importing the Categories slice that owns its metadata.
 */
export const CategoryId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("CategoryId"))
  .annotate({ identifier: "CategoryId" });
export type CategoryId = typeof CategoryId.Type;

const maximumCategoryTextLength = 80;

/** Stable identity of one user keyword rule; tie-breaking may rely on its lexical UUID order. */
export const KeywordRuleId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("KeywordRuleId"))
  .annotate({ identifier: "KeywordRuleId" });
export type KeywordRuleId = typeof KeywordRuleId.Type;

/** Spanish label shown for a Category; changing it never changes Category identity. */
export const CategoryLabel = Schema.NonEmptyString.check(Schema.isTrimmed())
  .check(Schema.isMaxLength(maximumCategoryTextLength))
  .pipe(Schema.brand("CategoryLabel"))
  .annotate({ identifier: "CategoryLabel" });
export type CategoryLabel = typeof CategoryLabel.Type;

/** User-authored counterparty fragment retained with its spelling but normalized only while matching. */
export const CategoryKeyword = Schema.NonEmptyString.check(Schema.isTrimmed())
  .check(Schema.isMaxLength(maximumCategoryTextLength))
  .check(
    Schema.makeFilter((keyword) =>
      keyword.normalize("NFD").replaceAll(/[\u0300-\u036f]/g, "").length > 0
        ? undefined
        : "Expected a keyword containing a letter or number"
    )
  )
  .pipe(Schema.brand("CategoryKeyword"))
  .annotate({ identifier: "CategoryKeyword" });
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
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
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
/** The requested stable Category identity is not present in the configured taxonomy. */
export class CategoryNotFound extends Data.TaggedError("CategoryNotFound")<{
  readonly categoryId: CategoryId;
}> {}

/** The User already has a rule with the same normalized keyword. */
export class KeywordRuleAlreadyExists extends Data.TaggedError("KeywordRuleAlreadyExists")<{
  readonly keyword: CategoryKeyword;
}> {}

/** The requested rule does not belong to the current User or no longer exists. */
export class KeywordRuleNotFound extends Data.TaggedError("KeywordRuleNotFound")<{
  readonly keywordRuleId: KeywordRuleId;
}> {}

/** The User already retains the bounded maximum of capture-time keyword rules. */
export class KeywordRuleLimitReached extends Data.TaggedError("KeywordRuleLimitReached")<{
  readonly maximum: number;
}> {}

/** Actionable failures produced while validating or changing Category rules. */
export type CategoryFailure =
  | CategoryNotFound
  | KeywordRuleAlreadyExists
  | KeywordRuleNotFound
  | KeywordRuleLimitReached;
/** Stable identities for the Colombian Categories. */
export const categoryIds = {
  restaurantes: CategoryId.make("10000000-0000-4000-8000-000000000001"),
  domicilios: CategoryId.make("10000000-0000-4000-8000-000000000002"),
  mercado: CategoryId.make("10000000-0000-4000-8000-000000000003"),
  transporte: CategoryId.make("10000000-0000-4000-8000-000000000004"),
  vivienda: CategoryId.make("10000000-0000-4000-8000-000000000005"),
  servicios: CategoryId.make("10000000-0000-4000-8000-000000000006"),
  salud: CategoryId.make("10000000-0000-4000-8000-000000000007"),
  educacion: CategoryId.make("10000000-0000-4000-8000-000000000008"),
  compras: CategoryId.make("10000000-0000-4000-8000-000000000009"),
  entretenimiento: CategoryId.make("10000000-0000-4000-8000-000000000010"),
  viajes: CategoryId.make("10000000-0000-4000-8000-000000000011"),
  impuestos: CategoryId.make("10000000-0000-4000-8000-000000000012"),
  transferencias: CategoryId.make("10000000-0000-4000-8000-000000000013"),
  retirosDeEfectivo: CategoryId.make("10000000-0000-4000-8000-000000000014"),
  ingresos: CategoryId.make("10000000-0000-4000-8000-000000000015"),
  otros: CategoryId.make("10000000-0000-4000-8000-000000000016"),
} as const;
