import type { OAuthCaller } from "../../../src/shell/oauth-agents/contract";
import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import type { KeywordRuleOperation, KeywordRuleOutcome } from "../contract";
import {
  insertKeywordRule,
  keywordRulesFromRows,
  protectedKeywordRulesQuery,
  recordBrowserKeywordRuleWork,
  removeKeywordRule,
  replaceKeywordRule,
} from "./keyword-rules";
import {
  CategoryKeyword,
  CategoryNotFound,
  CreateKeywordRuleInput,
  KeywordRuleId,
  UpdateKeywordRuleInput,
  maximumKeywordRulesPerUser,
} from "../../../src/core/categories/contract";
import { ListKeywordRulesResponse } from "../../../src/shell/categories/contract";
import { NotFound, ValidationFailed } from "../../../src/shell/public-http/contract";
import { normalizeSearchText as normalizeCategoryKeyword } from "../../../src/core/search/operations";
import { recordAuthorizedCall, recordCanonicalPATWork } from "../../../src/shell/audit/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import { RequestBodyPolicy } from "../../http/contract";
import { pathId, readBoundedRequestBody } from "../../http/operations";
import {
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  findExistingCategory,
  findOwnedKeywordRules,
  keywordRuleJsonHeaders,
} from "./keyword-rule-shared";
import { validateKeywordRuleChange } from "../../../src/core/categories/operations";
import {
  type QueryCaller,
  type TransactionCaller,
  callerAuthority,
  callerScope,
  credentialRefusedPreparation,
  failedPreparation,
  isHostedCaller,
  isOAuthCaller,
  isPATCaller,
  liveTransactionAuthority,
  refusedPreparation,
  refusedTransactionWork,
  unavailablePreparation,
  transactionId as uuid,
} from "../../canonical-work/operations";
import type { CanonicalMutationPreparation } from "../../canonical-operations/contract";
import {
  keywordRuleGuardFor,
  keywordRuleOutcome,
  keywordRuleRefusal,
  keywordRuleUnavailable,
} from "./keyword-rule-outcome";
import { ruleOAuthReview } from "./oauth-review";
import type { OAuthMutationReview } from "../../oauth-confirmation/contract";

const HTTP_OK = 200;
const auditFromEnd = -2;
const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});
const CreateInput = Schema.toCodecJson(CreateKeywordRuleInput);
const UpdateInput = Schema.toCodecJson(UpdateKeywordRuleInput);
type Subject = TransactionCaller;

const jsonResponse = (body: string, status: number): Response =>
  new Response(body, { headers: keywordRuleJsonHeaders, status });

export const keywordRuleInvalidInput = (): Response =>
  jsonResponse(
    JSON.stringify(
      Schema.encodeSync(Schema.toCodecJson(ValidationFailed))(
        ValidationFailed.make({
          error: {
            code: "validation_failed",
            message: "Invalid keyword rule input. Correct it and send the whole request again.",
            fields: [],
          },
          next: [],
        })
      )
    ),
    HTTP_BAD_REQUEST
  );

export const keywordRuleUnknownId = (): Response =>
  jsonResponse(
    JSON.stringify(
      Schema.encodeSync(Schema.toCodecJson(NotFound))(
        NotFound.make({
          error: {
            code: "not_found",
            message: "No keyword rule with that id belongs to you.",
          },
          next: [],
        })
      )
    ),
    HTTP_NOT_FOUND
  );

export const keywordRuleInput = ({
  request,
  update,
}: Readonly<{ request: Request; update: boolean }>): Promise<
  Option.Option<CreateKeywordRuleInput>
> => {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return Promise.resolve(Option.none());
  }
  const input = update ? UpdateInput : CreateInput;
  return Effect.runPromise(readBoundedRequestBody(request, bodyPolicy))
    .then((bytes) => {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return Schema.decodeUnknownOption(input)(parsed);
    })
    .catch(() => Option.none());
};

export const keywordRuleIdFromPath = (request: Request): Option.Option<KeywordRuleId> =>
  pathId({ schema: KeywordRuleId, request });

class KeywordRuleBoundaryFailure extends Data.TaggedError("KeywordRuleBoundaryFailure")<{}> {}

const oauthWriteAudit = (
  input: Readonly<{
    db: D1Database;
    subject: OAuthCaller;
    operation: KeywordRuleOperation;
    current: number;
  }>
): D1PreparedStatement => {
  const auditStatement = recordAuthorizedCall({
    authority: callerAuthority(input),
    operation: input.operation,
    id: uuid(),
    current: input.current,
    outcome: "accepted",
    afterOwnerWrite: true,
  });
  return input.db.prepare(auditStatement.sql).bind(...auditStatement.params);
};

const writeStatements = ({
  db,
  subject,
  operation,
  statement,
  current,
}: Readonly<{
  db: D1Database;
  subject: Subject;
  operation: KeywordRuleOperation;
  statement: D1PreparedStatement;
  current: number;
}>): ReadonlyArray<D1PreparedStatement> => {
  if (isHostedCaller(subject)) {
    const audit = recordAuthorizedCall({
      authority: subject.authority,
      id: uuid(),
      current,
      operation,
      outcome: "accepted",
      afterOwnerWrite: true,
    });
    return [statement, db.prepare(audit.sql).bind(...audit.params)];
  }
  if (isOAuthCaller(subject)) {
    return [statement, oauthWriteAudit({ db, subject, operation, current })];
  }
  const pat = isPATCaller(subject);
  const auditStatement = pat
    ? recordCanonicalPATWork({
        authority: livePATAuthority({ subject, current }),
        input: {
          id: uuid(),
          current,
          operation,
          outcome: "accepted",
          afterOwnerWrite: true,
        },
      })
    : recordBrowserKeywordRuleWork({
        subject,
        operation,
        id: uuid(),
        current,
      });
  return [
    ...(pat
      ? [recordLivePATUse({ subject, current })].map(({ sql, params }) =>
          db.prepare(sql).bind(...params)
        )
      : []),
    statement,
    db.prepare(auditStatement.sql).bind(...auditStatement.params),
  ];
};

type RuleWrite = Readonly<{
  db: D1Database;
  subject: Subject;
  outcome: KeywordRuleOutcome;
  statement: D1PreparedStatement;
  current: number;
}>;

const preparedRuleWrite = (
  write: RuleWrite,
  oauthReview: Option.Option<OAuthMutationReview>
): CanonicalMutationPreparation => ({
  _tag: "Prepared",
  mutation: {
    oauthReview,
    requiredScope: callerScope(write.subject),
    guardRefusal: keywordRuleGuardFor(write.outcome),
    outcome: keywordRuleOutcome(write.outcome),

    commitGuards:
      write.outcome.operation === "categories.createKeywordRule"
        ? Option.some(({ db, userId, index }) => [
            db
              .prepare(
                `INSERT INTO canonical_child_guard
          (child_index,accepted,capacity_ok)
          SELECT ?,1,CASE WHEN (SELECT count(*) FROM keyword_rules WHERE user_id = ?) < ?
            THEN 1 ELSE 0 END
          ON CONFLICT(child_index) DO UPDATE SET accepted = excluded.accepted, capacity_ok = excluded.capacity_ok`
              )
              .bind(index, userId, maximumKeywordRulesPerUser),
          ])
        : Option.none(),
    statements: writeStatements({
      db: write.db,
      subject: write.subject,
      operation: write.outcome.operation,
      statement: write.statement,
      current: write.current,
    }),
  },
});

const prepareRuleWrite = (
  write: RuleWrite
): Effect.Effect<CanonicalMutationPreparation, KeywordRuleBoundaryFailure> =>
  Effect.gen(function* () {
    const live = yield* Effect.option(
      Effect.tryPromise(() =>
        liveTransactionAuthority({
          db: write.db,
          subject: write.subject,
          current: write.current,
        })
      )
    );
    if (Option.isNone(live)) return unavailablePreparation();
    if (!live.value) return credentialRefusedPreparation();
    if (write.outcome.operation !== "categories.deleteKeywordRule") {
      const categoryId = write.outcome.categoryId;
      const exists = yield* findExistingCategory({ db: write.db, categoryId });
      if (Option.isNone(exists)) return unavailablePreparation();
      if (!exists.value) {
        return refusedPreparation(
          keywordRuleRefusal({
            failure: new CategoryNotFound({ categoryId }),
            subject: write.subject,
          })
        );
      }
    }
    const stored = yield* Effect.tryPromise({
      try: () => findOwnedKeywordRules({ db: write.db, userId: write.subject.userId }),
      catch: () => new KeywordRuleBoundaryFailure(),
    });
    if (Option.isNone(stored)) return yield* new KeywordRuleBoundaryFailure();
    const conflict = yield* validateKeywordRuleChange({
      rules: stored.value,
      change: write.outcome,
    });
    if (Option.isSome(conflict)) {
      return refusedPreparation(
        keywordRuleRefusal({ failure: conflict.value, subject: write.subject })
      );
    }
    const review = yield* ruleOAuthReview(write).pipe(Effect.option);
    return Option.match(review, {
      onNone: unavailablePreparation,
      onSome: (value) => preparedRuleWrite(write, value),
    });
  });

export const prepareCreateKeywordRule = ({
  db,
  subject,
  payload,
  current,
}: Readonly<{
  db: D1Database;
  subject: Subject;
  payload: CreateKeywordRuleInput;
  current: number;
}>): Effect.Effect<CanonicalMutationPreparation> => {
  const ruleId = KeywordRuleId.make(uuid());
  const authority = callerAuthority({ subject, current });
  const keyword = CategoryKeyword.make(normalizeCategoryKeyword(payload.keyword));
  const ruleStatement = insertKeywordRule({
    id: ruleId,
    userId: subject.userId,
    keyword,
    categoryId: payload.categoryId,
    timestamp: current,
    authority,
  });
  return prepareRuleWrite({
    db,
    subject,
    outcome: {
      _tag: "KeywordRule",
      operation: "categories.createKeywordRule",
      ruleId,
      keyword,
      categoryId: payload.categoryId,
    },
    statement: db.prepare(ruleStatement.sql).bind(...ruleStatement.params),

    current,
  }).pipe(Effect.orElseSucceed(failedPreparation));
};

export const prepareUpdateKeywordRule = ({
  db,
  subject,
  ruleId,
  payload,
  current,
}: Readonly<{
  db: D1Database;
  subject: Subject;
  ruleId: KeywordRuleId;
  payload: UpdateKeywordRuleInput;
  current: number;
}>): Effect.Effect<CanonicalMutationPreparation> => {
  const authority = callerAuthority({ subject, current });
  const keyword = CategoryKeyword.make(normalizeCategoryKeyword(payload.keyword));
  const ruleStatement = replaceKeywordRule({
    id: ruleId,
    userId: subject.userId,
    keyword,
    categoryId: payload.categoryId,
    timestamp: current,
    authority,
  });
  return prepareRuleWrite({
    db,
    subject,
    outcome: {
      _tag: "KeywordRule",
      operation: "categories.updateKeywordRule",
      ruleId,
      keyword,
      categoryId: payload.categoryId,
    },
    statement: db.prepare(ruleStatement.sql).bind(...ruleStatement.params),

    current,
  }).pipe(Effect.orElseSucceed(failedPreparation));
};

export const prepareDeleteKeywordRule = ({
  db,
  subject,
  ruleId,
  current,
}: Readonly<{
  db: D1Database;
  subject: Subject;
  ruleId: KeywordRuleId;
  current: number;
}>): Effect.Effect<CanonicalMutationPreparation> => {
  const authority = callerAuthority({ subject, current });
  const ruleStatement = removeKeywordRule({
    id: ruleId,
    userId: subject.userId,
    authority,
  });
  return prepareRuleWrite({
    db,
    subject,
    outcome: { _tag: "KeywordRule", operation: "categories.deleteKeywordRule", ruleId },
    statement: db.prepare(ruleStatement.sql).bind(...ruleStatement.params),

    current,
  }).pipe(Effect.orElseSucceed(failedPreparation));
};

const listStatements = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  current: number;
}>): Array<D1PreparedStatement> => {
  const pat = isPATCaller(subject);
  const ruleStatement = protectedKeywordRulesQuery({
    userId: subject.userId,
    authority: callerAuthority({ subject, current }),
  });
  const auditStatement = pat
    ? recordCanonicalPATWork({
        authority: livePATAuthority({ subject, current }),
        input: {
          id: uuid(),
          current,
          operation: "categories.listKeywordRules",
          outcome: "accepted",
          afterOwnerWrite: false,
        },
      })
    : listAudit(subject, current);
  return [
    ...(pat
      ? [recordLivePATUse({ subject, current })].map(({ sql, params }) =>
          db.prepare(sql).bind(...params)
        )
      : []),
    db.prepare(ruleStatement.sql).bind(...ruleStatement.params),
    db.prepare(auditStatement.sql).bind(...auditStatement.params),
  ];
};
const listAudit = (
  subject: Exclude<QueryCaller, { patId: string }>,
  current: number
): ReturnType<typeof recordAuthorizedCall> => {
  const fields = {
    id: uuid(),
    current,
    operation: "categories.listKeywordRules" as const,
    afterOwnerWrite: false,
  };
  if (isHostedCaller(subject)) {
    return recordAuthorizedCall({ ...fields, authority: subject.authority, outcome: "accepted" });
  }
  if (isOAuthCaller(subject)) {
    return recordAuthorizedCall({
      ...fields,
      authority: callerAuthority({ subject, current }),
      outcome: "accepted",
    });
  }
  return recordAuthorizedCall({
    ...fields,
    authority: liveWebSessionAuthority({ subject, current }),
    outcome: "success",
  });
};

const refusedWork = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: QueryCaller }>): Effect.Effect<Response> =>
  Effect.tryPromise(() => refusedTransactionWork({ db, subject })).pipe(
    Effect.orElseSucceed(keywordRuleUnavailable)
  );

export const listOwnKeywordRules = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: QueryCaller }>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = DateTime.toEpochMillis(yield* DateTime.now);
    const statements = listStatements({ db, subject, current });
    const results = yield* Effect.tryPromise(() => db.batch(statements));
    const auditAccepted =
      results.at(-1)?.meta.changes === 1 &&
      (!isPATCaller(subject) || results[0]?.meta.changes === 1);
    if (!auditAccepted) return yield* refusedWork({ db, subject });
    const rules = keywordRulesFromRows(results.at(auditFromEnd)?.results);
    if (Option.isNone(rules)) return keywordRuleUnavailable();
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(ListKeywordRulesResponse))({
      data: rules.value,
      next: [],
    });
    return jsonResponse(body, HTTP_OK);
  }).pipe(Effect.orElseSucceed(keywordRuleUnavailable));
