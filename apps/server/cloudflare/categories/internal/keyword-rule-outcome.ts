import type { KeywordRuleOutcome } from "../contract";
import { keywordRuleFromRows, keywordRuleQuery } from "./keyword-rules";
import { Effect, Option, Schema } from "effect";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import { livePATAuthority } from "../../../src/shell/tokens/operations";
import { newId } from "../../secret-material/operations";
import {
  type CategoryFailure,
  CategoryNotFound,
  KeywordRule,
  KeywordRuleAlreadyExists,
  KeywordRuleId,
  KeywordRuleLimitReached,
  maximumKeywordRulesPerUser,
} from "../../../src/core/categories/contract";
import { NotFound, ValidationFailed } from "../../../src/shell/public-http/contract";
import { type SuggestedOperationCaller } from "../../../src/shell/canonical-operations/operations";
import { normalizeSearchText as normalizeCategoryKeyword } from "../../../src/core/search/operations";
import { toApiFailure } from "../../../src/shell/categories/operations";
import {
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  findExistingCategory,
  findOwnedKeywordRules,
  keywordRuleJsonHeaders,
} from "./keyword-rule-shared";
import { validateKeywordRuleChange } from "../../../src/core/categories/operations";
import type {
  CanonicalMutationRefusal,
  CommittedMutationValue,
  GuardRefusalWork,
  OwnerOutcome,
} from "../../canonical-operations/contract";
import {
  type TransactionCaller,
  callerAuthority,
  isHostedCaller,
  isOAuthCaller,
  isPATCaller,
} from "../../canonical-work/operations";

const HTTP_UNAVAILABLE = 503;

const suggestionCaller = (subject: TransactionCaller): SuggestedOperationCaller =>
  isPATCaller(subject)
    ? {
        accessCaller: { _tag: "PAT", capabilities: Option.toArray(subject.requiredScope) },
        tier: "free",
      }
    : { accessCaller: { _tag: "WebSession", fresh: false }, tier: "free" };

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

export const keywordRuleUnavailable = (): Response =>
  new Response(JSON.stringify({ status: "unavailable" }), {
    headers: keywordRuleJsonHeaders,
    status: HTTP_UNAVAILABLE,
  });

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
}>): Effect.Effect<"recorded" | "credential_refused" | "unavailable"> => {
  if (isOAuthCaller(subject) || isHostedCaller(subject)) {
    return Effect.tryPromise(() =>
      prepareAuthorizedAuditCall({
        db,
        authority: callerAuthority({ subject, current }),
        id: newId(),
        operation,
        outcome: "rejected",
        current,
        afterOwnerWrite: false,
      }).run()
    ).pipe(
      Effect.map((result) =>
        result.meta.changes === 1 ? ("recorded" as const) : ("credential_refused" as const)
      ),
      Effect.orElseSucceed(() => "unavailable" as const)
    );
  }
  let statement: D1PreparedStatement;
  if (isPATCaller(subject)) {
    const auditStatement = recordCanonicalPATWork({
      authority: livePATAuthority({ subject, current }),
      input: { id: newId(), current, operation, outcome: "rejected", afterOwnerWrite: false },
    });
    statement = db.prepare(auditStatement.sql).bind(...auditStatement.params);
  } else {
    const authority = liveWebSessionAuthority({ subject, current });
    statement = prepareAuthorizedAuditCall({
      db,
      authority,
      id: newId(),
      operation,
      outcome: "validation_failed",
      current,
      afterOwnerWrite: false,
    });
  }
  return Effect.tryPromise(() => statement.run()).pipe(
    Effect.map((result) =>
      result.meta.changes === 1 ? ("recorded" as const) : ("credential_refused" as const)
    ),
    Effect.orElseSucceed(() => "unavailable" as const)
  );
};

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

const missingCategoryFailure = ({
  db,
  outcome,
}: Readonly<{ db: D1Database; outcome: KeywordRuleOutcome }>): Effect.Effect<
  Option.Option<CategoryFailure>
> =>
  Effect.gen(function* () {
    if (outcome.operation === "categories.deleteKeywordRule") return Option.none<CategoryFailure>();
    const categoryId = outcome.categoryId;
    const exists = yield* findExistingCategory({ db, categoryId });
    return Option.getOrElse(exists, () => true)
      ? Option.none<CategoryFailure>()
      : Option.some(new CategoryNotFound({ categoryId }));
  });

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
            candidate._tag === "Owner" &&
            Option.isSome(candidate.guardFacts) &&
            candidate.guardFacts.value._tag === "KeywordRule"
              ? [candidate.guardFacts.value]
              : []
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
      return Option.none<CategoryFailure>();
    }
    return yield* validateKeywordRuleChange({ rules: projected, change: outcome });
  });

export const findKeywordRuleValue = ({
  db,
  userId,
  outcome,
}: Readonly<{ db: D1Database; userId: string; outcome: KeywordRuleOutcome }>): Effect.Effect<
  Option.Option<CommittedMutationValue>
> =>
  outcome.operation === "categories.deleteKeywordRule"
    ? Effect.succeedSome({
        _tag: "Owner" as const,
        payload: outcome.ruleId,
        encode: () => Schema.encodeEffect(Schema.toCodecJson(KeywordRuleId))(outcome.ruleId),
      })
    : Effect.tryPromise(() => findOwnedRule({ db, userId, id: outcome.ruleId })).pipe(
        Effect.map(
          Option.map((rule) => ({
            _tag: "Owner" as const,
            payload: rule,
            encode: () => Schema.encodeEffect(Schema.toCodecJson(KeywordRule))(rule),
          }))
        ),
        Effect.orElseSucceed(() => Option.none<CommittedMutationValue>())
      );

export const keywordRuleOutcome = (outcome: KeywordRuleOutcome): OwnerOutcome => ({
  _tag: "Owner",
  operation: outcome.operation,
  guardFacts: Option.some(outcome),
  collisionKey: Option.some(`keyword-rule:${outcome.ruleId}`),
  read: (db, userId) => findKeywordRuleValue({ db, userId, outcome }),
});
