import { localRuleReview } from "./oauth-review";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Predicate, Schema } from "effect";
import {
  type CategoryFailure,
  CategoryKeyword,
  CategoryNotFound,
  type CreateKeywordRuleInput,
  KeywordRule,
  KeywordRuleId,
  KeywordRuleLimitReached,
  maximumKeywordRulesPerUser,
} from "../../../src/core/categories/contract";
import { validateKeywordRuleChange } from "../../../src/core/categories/operations";
import { normalizeSearchText } from "../../../src/core/search/operations";
import type { UserId } from "../../../src/core/identity/contract";
import {
  type CanonicalRejection,
  CurrentSuggestionCaller,
  canonicalRejectionStatus,
  rejection,
} from "../../canonical-admission/contract";
import type { SuggestedOperationCaller } from "../../../src/shell/canonical-operations/operations";
import { toApiFailure } from "../../../src/shell/categories/operations";
import { prepareLocalWrite } from "../../canonical-admission/operations";
import type { LocalMutationPlan, LocalMutationResult } from "../../canonical-admission/contract";
import { newId } from "../../secret-material/operations";
import { CategoriesUnavailable, KeywordRuleChange, KeywordRuleRemoval } from "../contract";
import { resolveLocalCategory, retainLocalCategory } from "./native-categorization";
import { keywordRuleFromRows, keywordRulesFromRows, keywordRulesQuery } from "./keyword-rules";

const createdStatus = 201;

const updatedStatus = 200;

const rulesFor = Effect.fn(function* (user: UserId) {
  const sql = yield* SqliteClient;
  const query = keywordRulesQuery({ userId: user });

  return yield* Effect.fromOption(
    keywordRulesFromRows(yield* sql.unsafe(query.sql, query.params)),
    () => new CategoriesUnavailable()
  );
});

export const localKeywordRules = Effect.fn(function* (user: UserId) {
  const rules = yield* rulesFor(user);

  return {
    status: 200,
    outcome: "success" as const,
    body: {
      data: yield* Schema.encodeEffect(Schema.toCodecJson(Schema.Array(KeywordRule)))(rules),
      next: [],
    },
  } satisfies LocalMutationResult;
});

const refusal = (
  failure: CategoryFailure,
  caller: SuggestedOperationCaller
): CanonicalRejection => {
  const value = toApiFailure({ failure, caller });

  return Predicate.isTagged(value, "NotFound")
    ? rejection({
        status: canonicalRejectionStatus.notFound,
        outcome: "not_found",
        code: "not_found",
        wireMessage: Option.some(value.error.message),
        fields: Option.none(),
        detail: Option.none(),
        next: value.next,
      })
    : rejection({
        status: canonicalRejectionStatus.badRequest,
        outcome: "validation_failed",
        code: "validation_failed",
        wireMessage: Option.some(value.error.message),
        fields: Option.some(value.error.fields),
        detail: Option.none(),
        next: value.next,
      });
};

type Command =
  | {
      operation: "categories.createKeywordRule" | "categories.updateKeywordRule";
      ruleId: KeywordRuleId;
      payload: CreateKeywordRuleInput;
    }
  | { operation: "categories.deleteKeywordRule"; ruleId: KeywordRuleId };

export const newKeywordRuleId = (): KeywordRuleId => KeywordRuleId.make(newId());

const keywordRemoval = ({
  target,
  user,
  ruleId,
}: {
  target: string;
  user: UserId;
  ruleId: KeywordRuleId;
}): LocalMutationPlan =>
  prepareLocalWrite({
    targets: [target],
    review: localRuleReview(
      user,
      KeywordRuleRemoval.make({ operation: "categories.deleteKeywordRule", ruleId })
    ),
    commit: Effect.gen(function* () {
      const sql = yield* SqliteClient;

      const removed =
        yield* sql`DELETE FROM keyword_rules WHERE user_id=${user} AND id=${ruleId} RETURNING id`;

      if (removed.length !== 1) return yield* new CategoriesUnavailable();

      return { status: 200, outcome: "success", body: { data: ruleId, next: [] } };
    }),
  });

const selectedCategory = Effect.fnUntraced(function* (
  user: UserId,
  categoryId: CreateKeywordRuleInput["categoryId"]
) {
  return yield* resolveLocalCategory({
    userId: user,
    capture: {
      caller: Option.some(categoryId),
      counterparty: Option.none(),
      direction: "outflow",
    },
  }).pipe(
    Effect.asSome,
    Effect.catchTag("CategoryNotFound", () => Effect.succeedNone)
  );
});

const savedKeyword = Effect.fn(function* (row: unknown, create: boolean) {
  const saved = keywordRuleFromRows(row);

  if (Option.isNone(saved)) return yield* new CategoriesUnavailable();

  return {
    status: create ? createdStatus : updatedStatus,
    outcome: "success" as const,
    body: {
      data: yield* Schema.encodeEffect(Schema.toCodecJson(KeywordRule))(saved.value),
      next: [],
    },
  } satisfies LocalMutationResult;
});

type NormalizedCommand =
  | Extract<Command, { operation: "categories.deleteKeywordRule" }>
  | (Extract<
      Command,
      { operation: "categories.createKeywordRule" | "categories.updateKeywordRule" }
    > & { keyword: CategoryKeyword });

const normalizedCommand = (command: Command): NormalizedCommand =>
  command.operation === "categories.deleteKeywordRule"
    ? command
    : {
        ...command,
        keyword: CategoryKeyword.make(normalizeSearchText(command.payload.keyword)),
      };

export const prepareLocalKeywordRule = Effect.fn(function* (
  command: Command,
  user: UserId,
  current: number
) {
  const suggestionCaller = yield* CurrentSuggestionCaller;
  const { operation, ruleId } = command;
  const sql = yield* SqliteClient;
  const rules = yield* rulesFor(user);

  const change = normalizedCommand(command);

  const failure = yield* validateKeywordRuleChange({ rules, change });

  if (Option.isSome(failure)) return yield* refusal(failure.value, suggestionCaller);

  const target = "keyword-rule:" + ruleId;

  if (change.operation === "categories.deleteKeywordRule") {
    return keywordRemoval({ target, user, ruleId });
  }

  const { keyword, payload } = change;
  const reference = yield* selectedCategory(user, payload.categoryId);

  if (Option.isNone(reference)) {
    return yield* refusal(
      new CategoryNotFound({ categoryId: payload.categoryId }),
      suggestionCaller
    );
  }

  const revision = reference.value.revision;
  const fields = sql`id,keyword,category_id AS categoryId,created_at_ms AS createdAt,updated_at_ms AS updatedAt`;

  return prepareLocalWrite({
    targets: [target, "keyword:" + keyword],
    review: localRuleReview(
      user,
      KeywordRuleChange.make({
        operation: change.operation,
        ruleId,
        keyword,
        categoryId: payload.categoryId,
      })
    ),
    commit: Effect.gen(function* () {
      yield* retainLocalCategory(reference.value);
      const create = operation === "categories.createKeywordRule";

      const changed = create
        ? yield* sql`INSERT INTO keyword_rules(id,user_id,keyword,category_id,category_revision,created_at_ms,updated_at_ms)
      SELECT ${ruleId},${user},${keyword},${payload.categoryId},${revision},${current},${current}
      WHERE (SELECT COUNT(*) FROM keyword_rules WHERE user_id=${user})<${maximumKeywordRulesPerUser} RETURNING ${fields}`
        : yield* sql`UPDATE keyword_rules SET keyword=${keyword},category_id=${payload.categoryId},category_revision=${revision},updated_at_ms=${current} WHERE user_id=${user} AND id=${ruleId} RETURNING ${fields}`;

      if (changed.length !== 1) {
        if (create && (yield* rulesFor(user)).length >= maximumKeywordRulesPerUser) {
          return yield* refusal(
            new KeywordRuleLimitReached({ maximum: maximumKeywordRulesPerUser }),
            suggestionCaller
          );
        }

        return yield* new CategoriesUnavailable();
      }

      return yield* savedKeyword(changed[0], create);
    }),
  });
});
