import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { SqlClient } from "effect/unstable/sql";
import { type UserId } from "~/core/_shared/user";
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
import { resolveCaller } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import { toApiFailure } from "./errors";
import {
  deleteKeywordRule,
  findCategory,
  insertKeywordRule,
  listCategories,
  listKeywordRules,
  lockKeywordRules,
  updateKeywordRule,
} from "./repo";
const missingRule = (keywordRuleId: KeywordRuleId) => () =>
  new KeywordRuleNotFound({ keywordRuleId });

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
}) =>
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
}: Readonly<{ userId: UserId; input: CreateKeywordRuleInput }>) =>
  Effect.gen(function* () {
    yield* findCategory(input.categoryId).pipe(
      Effect.flatMap(
        Effect.fromOption(() => new CategoryNotFound({ categoryId: input.categoryId }))
      ),
      Effect.mapError(toApiFailure)
    );
    const sql = yield* SqlClient.SqlClient;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* lockKeywordRules(userId);
          const rules = yield* listKeywordRules(userId);
          yield* validateKeywordRules({
            rules,
            keyword: input.keyword,
            except: Option.none(),
            enforceCapacity: true,
          }).pipe(Effect.mapError(toApiFailure));
          return yield* insertKeywordRule(userId, input);
        })
      )
      .pipe(Effect.catchTag("SqlError", Effect.die));
  });

const updateRule = ({
  userId,
  id,
  input,
}: Readonly<{ userId: UserId; id: KeywordRuleId; input: UpdateKeywordRuleInput }>) =>
  Effect.gen(function* () {
    yield* findCategory(input.categoryId).pipe(
      Effect.flatMap(
        Effect.fromOption(() => new CategoryNotFound({ categoryId: input.categoryId }))
      ),
      Effect.mapError(toApiFailure)
    );
    const sql = yield* SqlClient.SqlClient;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* lockKeywordRules(userId);
          const rules = yield* listKeywordRules(userId);
          yield* validateKeywordRules({
            rules,
            keyword: input.keyword,
            except: Option.some(id),
            enforceCapacity: false,
          }).pipe(Effect.mapError(toApiFailure));
          return yield* updateKeywordRule(userId, id, input);
        })
      )
      .pipe(Effect.catchTag("SqlError", Effect.die));
  });

/** Provides public Categories and bounded, deterministic User keyword-rule management. */
export const CategoriesLive = HttpApiBuilder.group(FidyApi, "categories", (handlers) =>
  handlers
    .handle("listCategories", ({ request }) =>
      Effect.gen(function* () {
        yield* resolveCaller(request);
        return { data: yield* listCategories, next: [] };
      })
    )
    .handle("listKeywordRules", ({ request }) =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* resolveCaller(request);
        return { data: yield* listKeywordRules(subjectUserId), next: [] };
      })
    )
    .handle("createKeywordRule", ({ payload, request }) =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* resolveCaller(request);
        const rule = yield* createRule({ userId: subjectUserId, input: payload });
        return { data: rule, next: [] };
      })
    )
    .handle("updateKeywordRule", ({ params, payload, request }) =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* resolveCaller(request);
        const found = yield* updateRule({
          userId: subjectUserId,
          id: params.id,
          input: payload,
        });
        const rule = yield* found.pipe(
          Effect.fromOption(missingRule(params.id)),
          Effect.mapError(toApiFailure)
        );
        return { data: rule, next: [] };
      })
    )
    .handle("deleteKeywordRule", ({ params, request }) =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* resolveCaller(request);
        const found = yield* deleteKeywordRule(subjectUserId, params.id);
        const id = yield* found.pipe(
          Effect.fromOption(missingRule(params.id)),
          Effect.mapError(toApiFailure)
        );
        return { data: id, next: [] };
      })
    )
);
