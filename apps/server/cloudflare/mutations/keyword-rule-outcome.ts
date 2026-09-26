import { Effect, Option, Schema } from "effect";
import { recordCanonicalPATWork } from "@fidy/server/tokens-runtime";
import { newId } from "../pats/pat-shared";
import { prepareOwnedStatement } from "../pats/pat-unit";
import { refusedByAuditBudget } from "../audit/audit-triggers";
import {
  type CategoryFailure,
  CategoryNotFound,
  type KeywordRule,
  KeywordRuleAlreadyExists,
  KeywordRuleLimitReached,
  NotFound,
  type SuggestedOperationCaller,
  ValidationFailed,
  keywordRuleFromRows,
  keywordRuleQuery,
  maximumKeywordRulesPerUser,
  normalizeCategoryKeyword,
  toApiFailure,
} from "@fidy/server/categories";
import {
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  findExistingCategory,
  findOwnedKeywordRules,
  keywordRuleJsonHeaders,
} from "../categories/keyword-rule-shared";
import { decideKeywordRuleConflict } from "../categories/keyword-rule-conflict";
import type {
  CanonicalMutationRefusal,
  CommittedMutationValue,
  GuardRefusalWork,
  KeywordRuleOutcome,
} from "./mutation-types";
import {
  type TransactionCaller,
  callerAuthority,
  isPATCaller,
} from "../transactions/transaction-boundary";
import { dailyAuditMessage } from "./transaction-outcome";

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

/** Persist the exact guarded child's refusal after its atomic unit has rolled back. */
const recordKeywordRuleGuard = ({
  db,
  subject,
  current,
  operation,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  operation: KeywordRuleOutcome["operation"];
}>): Effect.Effect<"recorded" | "credential_refused" | "rate_limited" | "unavailable"> => {
  const statement = isPATCaller(subject)
    ? prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          subject,
          input: { id: newId(), current, operation, outcome: "rejected", afterOwnerWrite: false },
        }),
      })
    : ((): D1PreparedStatement => {
        const authority = callerAuthority({ subject, current });
        return db
          .prepare(`INSERT INTO category_audit
          (id,user_id,session_id,operation,occurred_at_ms,outcome)
          SELECT ?,user_id,id,?,?,'validation_failed' FROM ${authority.table}
          WHERE ${authority.predicate}`)
          .bind(newId(), operation, current, ...authority.bindings);
      })();
  return Effect.tryPromise(() => statement.run()).pipe(
    Effect.map((result) =>
      result.meta.changes === 1 ? ("recorded" as const) : ("credential_refused" as const)
    ),
    Effect.catch((cause) =>
      Effect.succeed(
        refusedByAuditBudget(cause) ? ("rate_limited" as const) : ("unavailable" as const)
      )
    )
  );
};

/** Construct a proved keyword-rule guard refusal; its Audit is deferred to `record`. */
export const keywordRuleGuardRefusal = ({
  db,
  subject,
  current,
  operation,
  failure,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  operation: KeywordRuleOutcome["operation"];
  failure: Option.Option<CategoryFailure>;
}>): CanonicalMutationRefusal => {
  const declared = Option.map(failure, (value) => keywordRuleRefusal({ failure: value, subject }));
  return {
    code: Option.match(declared, {
      onNone: () => "validation_failed",
      onSome: (value) => value.code,
    }),
    message: Option.match(declared, {
      onNone: () => "The keyword rule could not complete its guarded write.",
      onSome: (value) => value.message,
    }),
    record: () => recordKeywordRuleGuard({ db, subject, current, operation }),
    respond: (disposition) =>
      Option.match(declared, {
        onNone: () =>
          disposition === "recorded"
            ? Effect.succeed(
                declareFailure(
                  ValidationFailed.make({
                    error: {
                      code: "validation_failed",
                      message: "The keyword rule could not complete its guarded write.",
                      fields: [],
                    },
                    next: [],
                  })
                )
              )
            : Effect.succeed(keywordRuleUnavailable()),
        onSome: (value) => value.respond(disposition),
      }),
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

/** Replay earlier rule children and construct a refusal whose Audit runs only on `record`. */
export const keywordRuleGuardFor =
  (outcome: KeywordRuleOutcome) =>
  ({
    db,
    subject,
    current,
    earlier,
    kind,
  }: GuardRefusalWork): Effect.Effect<CanonicalMutationRefusal> =>
    kind === "capacity"
      ? Effect.succeed(
          keywordRuleGuardRefusal({
            db,
            subject,
            current,
            operation: outcome.operation,
            failure: Option.some(
              new KeywordRuleLimitReached({ maximum: maximumKeywordRulesPerUser })
            ),
          })
        )
      : keywordRuleGuardFailure({
          db,
          userId: subject.userId,
          outcome,
          earlier: earlier.flatMap((candidate) =>
            candidate._tag === "KeywordRule" ? [candidate] : []
          ),
        }).pipe(
          Effect.map((failure) =>
            keywordRuleGuardRefusal({
              db,
              subject,
              current,
              operation: outcome.operation,
              failure,
            })
          ),
          Effect.orElseSucceed(() =>
            keywordRuleGuardRefusal({
              db,
              subject,
              current,
              operation: outcome.operation,
              failure: Option.none(),
            })
          )
        );

/** Explain a guarded rule child from earlier writes and retained state, or return None. */
export const keywordRuleGuardFailure = ({
  db,
  userId,
  outcome,
  earlier,
}: Readonly<{
  db: D1Database;
  userId: string;
  outcome: KeywordRuleOutcome;
  earlier: ReadonlyArray<KeywordRuleOutcome>;
}>): Effect.Effect<Option.Option<CategoryFailure>> =>
  Effect.gen(function* () {
    if (outcome.operation !== "categories.deleteKeywordRule") {
      const written = new Map<string, KeywordRuleOutcome>();
      for (const previous of earlier) {
        if (previous.operation === "categories.deleteKeywordRule") written.delete(previous.ruleId);
        else written.set(previous.ruleId, previous);
      }
      const duplicate = [...written.values()].some(
        (previous) =>
          previous.operation !== "categories.deleteKeywordRule" &&
          previous.ruleId !== outcome.ruleId &&
          normalizeCategoryKeyword(previous.keyword) === normalizeCategoryKeyword(outcome.keyword)
      );
      if (duplicate) return Option.some(new KeywordRuleAlreadyExists({ keyword: outcome.keyword }));
    }
    return yield* keywordRuleAbortFailure({ db, userId, outcome, earlier });
  });

/**
 * Find a missing Category, vanished rule, duplicate keyword, or exhausted rule set in retained
 * state after rollback. Return None when the retained state cannot prove any of those conflicts.
 */
export const keywordRuleAbortFailure = ({
  db,
  userId,
  outcome,
  earlier,
}: Readonly<{
  db: D1Database;
  userId: string;
  outcome: KeywordRuleOutcome;
  earlier: ReadonlyArray<KeywordRuleOutcome>;
}>): Effect.Effect<Option.Option<CategoryFailure>> =>
  Effect.gen(function* () {
    const category = yield* missingCategoryFailure({ db, outcome });
    if (Option.isSome(category)) return category;
    const rules = yield* Effect.tryPromise(() => findOwnedKeywordRules({ db, userId })).pipe(
      Effect.orElseSucceed(() => Option.none<ReadonlyArray<KeywordRule>>())
    );
    if (Option.isNone(rules)) return Option.none<CategoryFailure>();
    // The retained rows include writes undone by rollback. Reconstruct prior rule changes
    // before testing a conflict; a rule deleted earlier cannot be a duplicate here.
    const prior = new Map(earlier.map((change) => [change.ruleId, change]));
    const projected = rules.value.flatMap((rule) => {
      const change = prior.get(rule.id);
      if (change === undefined) return [rule];
      if (change.operation === "categories.deleteKeywordRule") return [];
      return [{ ...rule, keyword: change.keyword, categoryId: change.categoryId }];
    });
    if (
      outcome.operation !== "categories.createKeywordRule" &&
      !projected.some((rule) => rule.id === outcome.ruleId) &&
      prior.get(outcome.ruleId)?.operation === "categories.createKeywordRule"
    ) {
      // A rule created earlier was never in retained rows; absence after rollback proves nothing.
      return Option.none<CategoryFailure>();
    }
    return yield* decideKeywordRuleConflict({ rules: projected, outcome });
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
