import { Effect, Option, type Schema } from "effect";
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
import type { UserId } from "~/core/identity/reference";
import type { CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import type { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import type { OperationResponse } from "~/shell/_shared/response";
import type { SuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { toApiFailure } from "./errors";
import {
  deleteKeywordRuleInScope,
  findCategory,
  insertKeywordRuleInScope,
  listKeywordRulesInScope,
  updateKeywordRuleInScope,
  withKeywordLockInScope,
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

type MutationResponse<Data extends Schema.Top> = ReturnType<typeof OperationResponse<Data>>["Type"];

/** Identifies the authorized User and caller policy shared by Category keyword-rule mutations. */
export type KeywordRuleMutationContext = Readonly<{
  userId: UserId;
  caller: SuggestedOperationCaller;
}>;

/** Facts supplied after canonical decoding and authorization for keyword-rule creation. */
export type CreateKeywordRuleMutationInput = KeywordRuleMutationContext &
  Readonly<{ payload: CreateKeywordRuleInput }>;

/** Creates one validated keyword rule inside the caller-owned User-scoped transaction. */
export const createKeywordRule: CanonicalMutationImplementation<
  CreateKeywordRuleMutationInput,
  MutationResponse<typeof KeywordRule>,
  NotFound | ValidationFailed
> = Effect.fn("createKeywordRule")(function* ({ userId, caller, payload }) {
  yield* findCategory(payload.categoryId).pipe(
    Effect.flatMap(
      Effect.fromOption(() => new CategoryNotFound({ categoryId: payload.categoryId }))
    ),
    Effect.mapError(mapCategoryFailure(caller))
  );
  const rule = yield* withKeywordLockInScope(
    userId,
    Effect.gen(function* () {
      const rules = yield* listKeywordRulesInScope(userId);
      yield* validateKeywordRules({
        rules,
        keyword: payload.keyword,
        except: Option.none(),
        enforceCapacity: true,
      }).pipe(Effect.mapError(mapCategoryFailure(caller)));
      return yield* insertKeywordRuleInScope(userId, payload);
    })
  );
  return { data: rule, next: [] };
});

/** Facts supplied after canonical decoding and authorization for keyword-rule replacement. */
export type UpdateKeywordRuleMutationInput = KeywordRuleMutationContext &
  Readonly<{
    keywordRuleId: KeywordRuleId;
    payload: UpdateKeywordRuleInput;
  }>;

/** Replaces one validated keyword rule inside the caller-owned User-scoped transaction. */
export const updateKeywordRule: CanonicalMutationImplementation<
  UpdateKeywordRuleMutationInput,
  MutationResponse<typeof KeywordRule>,
  NotFound | ValidationFailed
> = Effect.fn("updateKeywordRule")(function* ({ userId, caller, keywordRuleId, payload }) {
  yield* findCategory(payload.categoryId).pipe(
    Effect.flatMap(
      Effect.fromOption(() => new CategoryNotFound({ categoryId: payload.categoryId }))
    ),
    Effect.mapError(mapCategoryFailure(caller))
  );
  const found = yield* withKeywordLockInScope(
    userId,
    Effect.gen(function* () {
      const rules = yield* listKeywordRulesInScope(userId);
      yield* validateKeywordRules({
        rules,
        keyword: payload.keyword,
        except: Option.some(keywordRuleId),
        enforceCapacity: false,
      }).pipe(Effect.mapError(mapCategoryFailure(caller)));
      return yield* updateKeywordRuleInScope(userId, keywordRuleId, payload);
    })
  );
  const rule = yield* found.pipe(
    Effect.fromOption(missingRule(keywordRuleId)),
    Effect.mapError(mapCategoryFailure(caller))
  );
  return { data: rule, next: [] };
});

/** Facts supplied after canonical decoding and authorization for keyword-rule deletion. */
export type DeleteKeywordRuleMutationInput = KeywordRuleMutationContext &
  Readonly<{ keywordRuleId: KeywordRuleId }>;

/** Deletes one keyword rule inside the caller-owned User-scoped transaction. */
export const deleteKeywordRule: CanonicalMutationImplementation<
  DeleteKeywordRuleMutationInput,
  MutationResponse<typeof KeywordRuleId>,
  NotFound
> = Effect.fn("deleteKeywordRule")(function* ({ userId, caller, keywordRuleId }) {
  const id = yield* deleteKeywordRuleInScope(userId, keywordRuleId).pipe(
    Effect.flatMap(Effect.fromOption(missingRule(keywordRuleId))),
    Effect.mapError((failure) => toApiFailure({ failure, caller }))
  );
  return { data: id, next: [] };
});
