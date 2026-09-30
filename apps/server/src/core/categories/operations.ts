import { normalizeSearchText } from "~/core/search/operations";
import { Effect, Option } from "effect";
import {
  type Category,
  type CategoryId,
  type CategoryKeyword,
  CategoryLabel,
  type KeywordRuleId,
  categoryIds,
} from "./contract";

/** Bounds the rules scanned during each Transaction capture for one User. */
export const maximumKeywordRulesPerUser = 100;

/** The last-resort capture Category when no explicit choice or User rule applies. */
export const fallbackCaptureCategory = (direction: "inflow" | "outflow"): CategoryId =>
  direction === "inflow" ? categoryIds.ingresos : categoryIds.otros;

type CategoryRule<Category extends string> = Readonly<{
  id: string;
  keyword: string;
  categoryId: Category;
}>;

type KeywordCategoryInput<Category extends string> = Readonly<{
  readonly counterparty: string;
  readonly rules: ReadonlyArray<CategoryRule<Category>>;
}>;

/** Selects the longest matching rule; lexical rule identity resolves equal-specificity ties. */
export const findKeywordCategory = <Category extends string>(
  input: KeywordCategoryInput<Category>
): Effect.Effect<Option.Option<Category>> => {
  const { counterparty, rules } = input;
  const normalizedCounterparty = normalizeCategoryKeyword(counterparty);
  const matching = rules
    .filter((rule) => normalizedCounterparty.includes(normalizeCategoryKeyword(rule.keyword)))
    .toSorted(
      (left, right) =>
        normalizeCategoryKeyword(right.keyword).length -
          normalizeCategoryKeyword(left.keyword).length || left.id.localeCompare(right.id)
    );

  const first = matching[0];
  return Effect.succeed(first === undefined ? Option.none() : Option.some(first.categoryId));
};

/** Decides whether a normalized keyword is already claimed, excluding one rule during updates. */
export const hasKeywordRule = ({
  keyword,
  rules,
  excluding,
}: Readonly<{
  readonly keyword: typeof CategoryKeyword.Encoded;
  readonly rules: ReadonlyArray<CategoryRule<string>>;
  readonly excluding: Option.Option<typeof KeywordRuleId.Encoded>;
}>): Effect.Effect<boolean> => {
  const normalized = normalizeCategoryKeyword(keyword);
  return Effect.succeed(
    rules.some(
      (rule) =>
        !(excluding._tag === "Some" && excluding.value === rule.id) &&
        normalizeCategoryKeyword(rule.keyword) === normalized
    )
  );
};

/** Decides whether one more rule fits the bounded set of retained User rules. */
export const canCreateKeywordRule = (
  rules: ReadonlyArray<CategoryRule<string>>
): Effect.Effect<boolean> => Effect.succeed(rules.length < maximumKeywordRulesPerUser);

type KnownCategories<Category extends string> = Readonly<{
  readonly caller: Option.Option<Category>;
  readonly keywordRule: Option.Option<Category>;
}>;

/** Selects an explicit Category before a User rule; None leaves the model fallback available. */
export const findKnownCaptureCategory = <Category extends string>(
  choices: KnownCategories<Category>
): Effect.Effect<Option.Option<Category>> =>
  Effect.succeed(Option.orElse(choices.caller, () => choices.keywordRule));

/** Seed-ready Colombian Categories in presentation order. */
const categoryRows = [
  {
    id: categoryIds.restaurantes,
    label: CategoryLabel.make("Restaurantes"),
    displayOrder: 0,
  },
  { id: categoryIds.domicilios, label: CategoryLabel.make("Domicilios"), displayOrder: 1 },
  { id: categoryIds.mercado, label: CategoryLabel.make("Mercado"), displayOrder: 2 },
  { id: categoryIds.transporte, label: CategoryLabel.make("Transporte"), displayOrder: 3 },
  { id: categoryIds.vivienda, label: CategoryLabel.make("Vivienda"), displayOrder: 4 },
  { id: categoryIds.servicios, label: CategoryLabel.make("Servicios"), displayOrder: 5 },
  { id: categoryIds.salud, label: CategoryLabel.make("Salud"), displayOrder: 6 },
  { id: categoryIds.educacion, label: CategoryLabel.make("Educación"), displayOrder: 7 },
  { id: categoryIds.compras, label: CategoryLabel.make("Compras"), displayOrder: 8 },
  {
    id: categoryIds.entretenimiento,
    label: CategoryLabel.make("Entretenimiento"),
    displayOrder: 9,
  },
  { id: categoryIds.viajes, label: CategoryLabel.make("Viajes"), displayOrder: 10 },
  { id: categoryIds.impuestos, label: CategoryLabel.make("Impuestos"), displayOrder: 11 },
  {
    id: categoryIds.transferencias,
    label: CategoryLabel.make("Transferencias"),
    displayOrder: 12,
  },
  {
    id: categoryIds.retirosDeEfectivo,
    label: CategoryLabel.make("Retiros de efectivo"),
    displayOrder: 13,
  },
  { id: categoryIds.ingresos, label: CategoryLabel.make("Ingresos"), displayOrder: 14 },
  { id: categoryIds.otros, label: CategoryLabel.make("Otros"), displayOrder: 15 },
] as const;

/** Launch Category choices in presentation order, without persistence attributes. */
export const listLaunchCategories = (): ReadonlyArray<Category> =>
  categoryRows.map(({ id, label }) => ({ id, label }));

/** Normalize counterparty fragments without altering their retained spelling. */
export const normalizeCategoryKeyword = normalizeSearchText;
