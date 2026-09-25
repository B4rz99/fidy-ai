import { Effect, Option, Schema } from "effect";
import {
  type CategoryFailure,
  CategoryNotFound,
  type KeywordRule,
  KeywordRuleAlreadyExists,
  KeywordRuleLimitReached,
  KeywordRuleNotFound,
  NotFound,
  type SuggestedOperationCaller,
  ValidationFailed,
  canCreateKeywordRule,
  hasKeywordRule,
  keywordRuleFromRows,
  keywordRuleQuery,
  maximumKeywordRulesPerUser,
  toApiFailure,
} from "@fidy/server/categories";
import {
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  findExistingCategory,
  findOwnedKeywordRules,
  keywordRuleJsonHeaders,
} from "../categories/keyword-rule-shared";
import type {
  CanonicalMutationOutcome,
  CanonicalMutationRefusal,
  CommittedMutationValue,
  KeywordRuleOutcome,
} from "./mutation-types";
import {
  type TransactionBoundaryFailure,
  type TransactionCaller,
  boundaryFailure,
  isPATCaller,
} from "../transactions/transaction-boundary";
import { countRows, dailyAuditMessage } from "./transaction-outcome";

const HTTP_UNAVAILABLE = 503;

/** Caller facts for suggestion policy. Every recovery target is a Free read, so tier never filters. */
const suggestionCaller = (subject: TransactionCaller): SuggestedOperationCaller =>
  isPATCaller(subject)
    ? {
        accessCaller: { _tag: "PAT", capabilities: Option.toArray(subject.requiredScope) },
        tier: "free",
      }
    : { accessCaller: { _tag: "WebSession", fresh: false }, tier: "free" };

/** Serve one declared keyword-rule failure with the status its own declaration carries. */
const declareFailure = (failure: ReturnType<typeof toApiFailure>): Response =>
  failure._tag === "NotFound"
    ? new Response(JSON.stringify(Schema.encodeSync(Schema.toCodecJson(NotFound))(failure)), {
        headers: keywordRuleJsonHeaders,
        status: HTTP_NOT_FOUND,
      })
    : new Response(
        JSON.stringify(Schema.encodeSync(Schema.toCodecJson(ValidationFailed))(failure)),
        {
          headers: keywordRuleJsonHeaders,
          status: HTTP_BAD_REQUEST,
        }
      );

/** The declared unavailable body this owner answers when no conflict explains an aborted unit. */
export const keywordRuleUnavailable = (): Response =>
  new Response(JSON.stringify({ status: "unavailable" }), {
    headers: keywordRuleJsonHeaders,
    status: HTTP_UNAVAILABLE,
  });

/**
 * One refused keyword-rule change: it records no refusal AuditLogEntry (the owner's rule writes
 * audit only accepted work) and renders the declared Category failure with its recovery hints.
 */
export const keywordRuleRefusal = ({
  failure,
  subject,
}: Readonly<{
  failure: CategoryFailure;
  subject: TransactionCaller;
}>): CanonicalMutationRefusal => {
  const declared = toApiFailure({ failure, caller: suggestionCaller(subject) });
  return {
    code: declared.error.code,
    message: declared.error.message,
    record: () => Effect.succeed("recorded" as const),
    respond: () => Effect.succeed(declareFailure(declared)),
  };
};

/**
 * The refusal a keyword-rule child reports when the shared daily audit budget, not the child,
 * refused its unit. The batch answers the canonical `rate_limited` result without a row, while the
 * individual entry point keeps its own classification: an aborted rule write that no conflict
 * explains is unavailable.
 */
export const keywordRuleBudgetRefusal = (): CanonicalMutationRefusal => ({
  code: "rate_limited",
  message: dailyAuditMessage,
  record: () => Effect.succeed("rate_limited" as const),
  respond: () => Effect.succeed(keywordRuleUnavailable()),
});

/** One owned rule by stable id; a foreign or absent id returns no row. */
const findOwnedRule = ({
  db,
  userId,
  id,
}: Readonly<{ db: D1Database; userId: string; id: string }>): Promise<
  Option.Option<KeywordRule>
> => {
  const query = keywordRuleQuery({ userId, id });
  return db
    .prepare(query.sql)
    .bind(...query.params)
    .first()
    .then(keywordRuleFromRows);
};

/** The failure for a Category the rolled-back state no longer contains, or None. */
const missingCategoryFailure = ({
  db,
  outcome,
}: Readonly<{
  db: D1Database;
  outcome: KeywordRuleOutcome;
}>): Effect.Effect<Option.Option<CategoryFailure>> =>
  Effect.gen(function* () {
    if (outcome.operation === "categories.deleteKeywordRule") return Option.none<CategoryFailure>();
    const categoryId = outcome.categoryId;
    // An unreadable Category never explains an abort: only a Category we proved absent is blamed.
    const exists = yield* findExistingCategory({ db, categoryId });
    return Option.getOrElse(exists, () => true)
      ? Option.none<CategoryFailure>()
      : Option.some(new CategoryNotFound({ categoryId }));
  });

/** The failure for a rule the rolled-back state no longer retains, or None. */
const missingRuleFailure = (
  rules: ReadonlyArray<KeywordRule>,
  outcome: KeywordRuleOutcome
): Option.Option<CategoryFailure> =>
  outcome.operation === "categories.createKeywordRule" ||
  rules.some((rule) => rule.id === outcome.ruleId)
    ? Option.none()
    : Option.some(new KeywordRuleNotFound({ keywordRuleId: outcome.ruleId }));

/** The failure for a keyword that conflicts with a retained rule, or None. */
const conflictingKeywordFailure = ({
  outcome,
  rules,
}: Readonly<{
  outcome: KeywordRuleOutcome;
  rules: ReadonlyArray<KeywordRule>;
}>): Effect.Effect<Option.Option<CategoryFailure>> =>
  Effect.gen(function* () {
    if (outcome.operation === "categories.deleteKeywordRule") return Option.none<CategoryFailure>();
    const excluding =
      outcome.operation === "categories.updateKeywordRule"
        ? Option.some(outcome.ruleId)
        : Option.none();
    const duplicate = yield* hasKeywordRule({ keyword: outcome.keyword, rules, excluding });
    return duplicate
      ? Option.some(new KeywordRuleAlreadyExists({ keyword: outcome.keyword }))
      : Option.none();
  });

/** The failure for an exhausted retained-rule set, or None. */
const exhaustedCapacityFailure = ({
  outcome,
  rules,
}: Readonly<{
  outcome: KeywordRuleOutcome;
  rules: ReadonlyArray<KeywordRule>;
}>): Effect.Effect<Option.Option<CategoryFailure>> =>
  Effect.gen(function* () {
    if (outcome.operation !== "categories.createKeywordRule") {
      return Option.none<CategoryFailure>();
    }
    const canCreate = yield* canCreateKeywordRule(rules);
    return canCreate
      ? Option.none()
      : Option.some(new KeywordRuleLimitReached({ maximum: maximumKeywordRulesPerUser }));
  });

/**
 * The failure one aborted keyword-rule child explains, or None when the rolled-back state cannot
 * name it: a missing Category, a vanished rule, a duplicate keyword, or an exhausted rule set.
 */
export const keywordRuleAbortFailure = ({
  db,
  userId,
  outcome,
}: Readonly<{
  db: D1Database;
  userId: string;
  outcome: KeywordRuleOutcome;
}>): Effect.Effect<Option.Option<CategoryFailure>> =>
  Effect.gen(function* () {
    const category = yield* missingCategoryFailure({ db, outcome });
    if (Option.isSome(category)) return category;
    const rules = yield* Effect.tryPromise(() => findOwnedKeywordRules({ db, userId })).pipe(
      Effect.orElseSucceed(() => Option.none<ReadonlyArray<KeywordRule>>())
    );
    if (Option.isNone(rules)) return Option.none<CategoryFailure>();
    const missingRule = missingRuleFailure(rules.value, outcome);
    if (Option.isSome(missingRule)) return missingRule;
    const conflict = yield* conflictingKeywordFailure({ outcome, rules: rules.value });
    if (Option.isSome(conflict)) return conflict;
    return yield* exhaustedCapacityFailure({ outcome, rules: rules.value });
  });

/**
 * Read one committed keyword-rule child's canonical value: the stored rule for a create or update,
 * and the removed id for a delete whose row the unit already proved gone.
 */
export const findKeywordRuleValue = ({
  db,
  userId,
  outcome,
}: Readonly<{
  db: D1Database;
  userId: string;
  outcome: KeywordRuleOutcome;
}>): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  outcome.operation === "categories.deleteKeywordRule"
    ? Effect.succeedSome({ _tag: "RemovedKeywordRule" as const, id: outcome.ruleId })
    : Effect.tryPromise(() => findOwnedRule({ db, userId, id: outcome.ruleId })).pipe(
        Effect.map((rule) =>
          Option.map(rule, (value) => ({ _tag: "KeywordRule" as const, rule: value }))
        ),
        Effect.orElseSucceed(() => Option.none<CommittedMutationValue>())
      );

/**
 * The create child an exhausted keyword-rule capacity blames: the child the replay finds over
 * budget, otherwise the first create child the trigger can belong to, and None when the unit
 * holds no create child. The retained count reads committed state, then earlier creates are
 * replayed.
 */
export const keywordRuleCapacityIndex = ({
  db,
  userId,
  mutations,
}: Readonly<{
  db: D1Database;
  userId: string;
  mutations: ReadonlyArray<{ readonly outcome: CanonicalMutationOutcome }>;
}>): Effect.Effect<Option.Option<number>, TransactionBoundaryFailure> =>
  Effect.tryPromise({
    try: () =>
      countRows(
        db.prepare("SELECT count(*) AS total FROM keyword_rules WHERE user_id = ?").bind(userId)
      ),
    catch: boundaryFailure,
  }).pipe(
    Effect.map((existing) => {
      const remaining = maximumKeywordRulesPerUser - existing;
      let createdIndex = -1;
      let firstOwned: Option.Option<number> = Option.none();
      for (const [index, mutation] of mutations.entries()) {
        if (
          mutation.outcome._tag !== "KeywordRule" ||
          mutation.outcome.operation !== "categories.createKeywordRule"
        ) {
          continue;
        }
        if (Option.isNone(firstOwned)) firstOwned = Option.some(index);
        createdIndex += 1;
        if (createdIndex >= remaining) return Option.some(index);
      }
      return firstOwned;
    })
  );
