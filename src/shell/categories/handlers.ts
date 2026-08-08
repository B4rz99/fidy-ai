import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { SqlClient } from "effect/unstable/sql";
import { type UserId } from "~/core/identity/reference";
import {
  CategoryNotFound,
  KeywordRuleAlreadyExists,
  KeywordRuleLimitReached,
  KeywordRuleNotFound,
} from "~/core/categories/errors";
import {
  type CategoryKeyword,
  type CreateKeywordRuleInput,
  type KeywordRule,
  type KeywordRuleId,
  type UpdateKeywordRuleInput,
} from "~/core/categories/model";
import {
  canCreateKeywordRule,
  hasKeywordRule,
  maximumKeywordRulesPerUser,
} from "~/core/categories/rules";
import { ResolvedCaller } from "~/shell/_shared/authz";
import type { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import {
  type SuggestedOperationCaller,
  makeFreeSuggestedOperationCaller,
} from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { toApiFailure } from "./errors";
import {
  deleteKeywordRule,
  findCategory,
  insertKeywordRule,
  listCategories,
  listKeywordRules,
  updateKeywordRule,
  withKeywordLock,
} from "./repo";

const missingRule = (keywordRuleId: KeywordRuleId) => (): KeywordRuleNotFound =>
  new KeywordRuleNotFound({ keywordRuleId });

const mapCategoryFailure =
  (caller: SuggestedOperationCaller) =>
  (failure: Parameters<typeof toApiFailure>[0]["failure"]): NotFound | ValidationFailed =>
    toApiFailure({ failure, caller });

const validateKeywordRules = ({
  rules,
  keyword,
  except,
  enforceCapacity,
}: {
  readonly rules: ReadonlyArray<KeywordRule>;
  readonly keyword: CategoryKeyword;
  readonly except: Option.Option<KeywordRuleId>;
  readonly enforceCapacity: boolean;
}): Effect.Effect<void, KeywordRuleAlreadyExists | KeywordRuleLimitReached> =>
  Effect.gen(function* () {
    if (yield* hasKeywordRule({ keyword, rules, excluding: except })) {
      return yield* new KeywordRuleAlreadyExists({ keyword });
    }
    if (enforceCapacity && !(yield* canCreateKeywordRule(rules))) {
      return yield* new KeywordRuleLimitReached({ maximum: maximumKeywordRulesPerUser });
    }
  });

const createRule = ({
  userId,
  input,
  caller,
}: Readonly<{
  userId: UserId;
  input: CreateKeywordRuleInput;
  caller: SuggestedOperationCaller;
}>): Effect.Effect<KeywordRule, NotFound | ValidationFailed, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    yield* findCategory(input.categoryId).pipe(
      Effect.flatMap(
        Effect.fromOption(() => new CategoryNotFound({ categoryId: input.categoryId }))
      ),
      Effect.mapError(mapCategoryFailure(caller))
    );
    return yield* withKeywordLock(
      userId,
      Effect.gen(function* () {
        const rules = yield* listKeywordRules(userId);
        yield* validateKeywordRules({
          rules,
          keyword: input.keyword,
          except: Option.none(),
          enforceCapacity: true,
        }).pipe(Effect.mapError(mapCategoryFailure(caller)));
        return yield* insertKeywordRule(userId, input);
      })
    );
  });

const updateRule = ({
  userId,
  id,
  input,
  caller,
}: Readonly<{
  userId: UserId;
  id: KeywordRuleId;
  input: UpdateKeywordRuleInput;
  caller: SuggestedOperationCaller;
}>): Effect.Effect<Option.Option<KeywordRule>, NotFound | ValidationFailed, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    yield* findCategory(input.categoryId).pipe(
      Effect.flatMap(
        Effect.fromOption(() => new CategoryNotFound({ categoryId: input.categoryId }))
      ),
      Effect.mapError(mapCategoryFailure(caller))
    );
    return yield* withKeywordLock(
      userId,
      Effect.gen(function* () {
        const rules = yield* listKeywordRules(userId);
        yield* validateKeywordRules({
          rules,
          keyword: input.keyword,
          except: Option.some(id),
          enforceCapacity: false,
        }).pipe(Effect.mapError(mapCategoryFailure(caller)));
        return yield* updateKeywordRule(userId, id, input);
      })
    );
  });

/** Provides public Categories and bounded, deterministic User keyword-rule management. */
export const CategoriesLive = HttpApiBuilder.group(FidyApi, "categories", (handlers) =>
  handlers
    .handle("listCategories", () =>
      Effect.gen(function* () {
        yield* ResolvedCaller;
        return { data: yield* listCategories, next: [] };
      })
    )
    .handle("listKeywordRules", () =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* ResolvedCaller;
        return { data: yield* listKeywordRules(subjectUserId), next: [] };
      })
    )
    .handle("createKeywordRule", ({ payload }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId } = yield* ResolvedCaller;
        const caller = makeFreeSuggestedOperationCaller(scopes);
        const rule = yield* createRule({ userId: subjectUserId, input: payload, caller });
        return { data: rule, next: [] };
      })
    )
    .handle("updateKeywordRule", ({ params, payload }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId } = yield* ResolvedCaller;
        const caller = makeFreeSuggestedOperationCaller(scopes);
        const found = yield* updateRule({
          userId: subjectUserId,
          id: params.id,
          input: payload,
          caller,
        });
        const rule = yield* found.pipe(
          Effect.fromOption(missingRule(params.id)),
          Effect.mapError(mapCategoryFailure(caller))
        );
        return { data: rule, next: [] };
      })
    )
    .handle("deleteKeywordRule", ({ params }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId } = yield* ResolvedCaller;
        const caller = makeFreeSuggestedOperationCaller(scopes);
        const found = yield* deleteKeywordRule(subjectUserId, params.id);
        const id = yield* found.pipe(
          Effect.fromOption(missingRule(params.id)),
          Effect.mapError(mapCategoryFailure(caller))
        );
        return { data: id, next: [] };
      })
    )
);
