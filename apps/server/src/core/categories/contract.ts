import { Data, Schema, Struct } from "effect";
import { NormalizedSearchText } from "~/core/search/contract";
import { UtcTimestamp } from "~/core/_shared/time";

export const CategoryId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("CategoryId"))
  .annotate({ identifier: "CategoryId" });

export type CategoryId = typeof CategoryId.Type;

const maximumCategoryTextLength = 80;

const normalizeCategoryKeyword = Schema.decodeSync(NormalizedSearchText);

export const KeywordRuleId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("KeywordRuleId"))
  .annotate({ identifier: "KeywordRuleId" });

export type KeywordRuleId = typeof KeywordRuleId.Type;

export const CategoryLabel = Schema.NonEmptyString.check(Schema.isTrimmed())
  .check(Schema.isMaxLength(maximumCategoryTextLength))
  .pipe(Schema.brand("CategoryLabel"))
  .annotate({ identifier: "CategoryLabel" });

export type CategoryLabel = typeof CategoryLabel.Type;

export const CategoryKeyword = Schema.NonEmptyString.check(Schema.isTrimmed())
  .check(Schema.isMaxLength(maximumCategoryTextLength))
  .check(
    Schema.makeFilter((keyword) => {
      const normalized = normalizeCategoryKeyword(keyword);

      return normalized.length > 0 &&
        normalized.length <= maximumCategoryTextLength &&
        normalized === normalized.trim()
        ? undefined
        : "Expected a normalized keyword of 1 to 80 characters without surrounding whitespace";
    })
  )
  .pipe(Schema.brand("CategoryKeyword"))
  .annotate({ identifier: "CategoryKeyword" });

export type CategoryKeyword = typeof CategoryKeyword.Type;

export const Category = Schema.Struct({
  id: CategoryId,
  label: CategoryLabel,
}).annotate({ identifier: "Category" });

export type Category = typeof Category.Type;

export const KeywordRule = Schema.Struct({
  id: KeywordRuleId,
  keyword: CategoryKeyword,
  categoryId: CategoryId,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotate({ identifier: "KeywordRule" });

export type KeywordRule = typeof KeywordRule.Type;

export const CreateKeywordRuleInput = KeywordRule.mapFields(
  Struct.omit(["id", "createdAt", "updatedAt"])
).annotate({ identifier: "CreateKeywordRuleInput" });

export type CreateKeywordRuleInput = typeof CreateKeywordRuleInput.Type;

export const UpdateKeywordRuleInput = CreateKeywordRuleInput.annotate({
  identifier: "UpdateKeywordRuleInput",
});

export type UpdateKeywordRuleInput = typeof UpdateKeywordRuleInput.Type;

export class CategoryNotFound extends Data.TaggedError("CategoryNotFound")<{
  readonly categoryId: CategoryId;
}> {}

export class KeywordRuleAlreadyExists extends Data.TaggedError("KeywordRuleAlreadyExists")<{
  readonly keyword: CategoryKeyword;
}> {}

export class KeywordRuleNotFound extends Data.TaggedError("KeywordRuleNotFound")<{
  readonly keywordRuleId: KeywordRuleId;
}> {}

export class KeywordRuleLimitReached extends Data.TaggedError("KeywordRuleLimitReached")<{
  readonly maximum: number;
}> {}

export type CategoryFailure =
  | CategoryNotFound
  | KeywordRuleAlreadyExists
  | KeywordRuleNotFound
  | KeywordRuleLimitReached;

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

export const maximumKeywordRulesPerUser = 100;

const maximumCategoriesPerRevision = 100;

const CategoryTaxonomyRevisionId = Schema.String.check(Schema.isPattern(/^co-[1-9][0-9]{0,8}$/u));

export const CategoryTaxonomyRevision = Schema.Struct({
  id: CategoryTaxonomyRevisionId,
  categories: Schema.Array(Category).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximumCategoriesPerRevision)
  ),
}).check(
  Schema.makeFilter(({ categories }) => {
    const ids = new Set(categories.map(({ id }) => id));

    return (
      (ids.size === categories.length &&
        ids.has(categoryIds.ingresos) &&
        ids.has(categoryIds.otros)) ||
      "Expected unique Category identities and both capture fallbacks"
    );
  })
);

export type CategoryTaxonomyRevision = typeof CategoryTaxonomyRevision.Type;

export const CategoryTaxonomyRelease = Schema.Struct({
  write: CategoryTaxonomyRevisionId,
  revisions: Schema.Array(CategoryTaxonomyRevision).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(({ write, revisions }) => {
    const ids = new Set(revisions.map(({ id }) => id));

    return (
      (ids.size === revisions.length && ids.has(write)) ||
      "Expected one definition per revision, including the writing revision"
    );
  })
);

export type CategoryTaxonomyRelease = typeof CategoryTaxonomyRelease.Type;

export const CategoryReference = Schema.Struct({
  revision: CategoryTaxonomyRevisionId,
  categoryId: CategoryId,
});

export type CategoryReference = typeof CategoryReference.Type;
