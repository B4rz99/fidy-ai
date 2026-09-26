import {
  CategoryNotFound,
  CreateKeywordRuleInput,
  KeywordRuleId,
  type KeywordRuleOperation,
  ListKeywordRulesResponse,
  NotFound,
  UpdateKeywordRuleInput,
  ValidationFailed,
  insertKeywordRule,
  keywordRulesFromRows,
  maximumKeywordRulesPerUser,
  normalizeCategoryKeyword,
  protectedKeywordRulesQuery,
  recordBrowserKeywordRuleRead,
  recordBrowserKeywordRuleWork,
  removeKeywordRule,
  replaceKeywordRule,
} from "@fidy/server/categories";
import { recordCanonicalPATWork, recordLivePATUse } from "@fidy/server/tokens-runtime";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import { prepareOwnedStatement } from "../pats/pat-unit";
import { RequestBodyPolicy, readBoundedRequestBody } from "../http/request-body";
import { pathId } from "../http/path";
import {
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  findExistingCategory,
  findOwnedKeywordRules,
  keywordRuleJsonHeaders,
} from "./keyword-rule-shared";
import { decideKeywordRuleConflict } from "./keyword-rule-conflict";
import {
  type TransactionCaller,
  callerAuthority,
  callerScope,
  isPATCaller,
  liveTransactionAuthority,
  transactionNow as now,
  refusedTransactionWork,
  transactionId as uuid,
} from "../transactions/transaction-boundary";
import {
  type CanonicalMutationPreparation,
  type KeywordRuleOutcome,
  credentialRefusedPreparation,
  failedPreparation,
  refusedPreparation,
  unavailablePreparation,
} from "../mutations/mutation-types";
import {
  keywordRuleGuardFor,
  keywordRuleRefusal,
  keywordRuleUnavailable,
} from "../mutations/keyword-rule-outcome";

const HTTP_OK = 200;
// The audit closes the list unit, so the rule rows sit one before it.
const auditFromEnd = -2;
// A keyword, a CategoryId, and the JSON envelope fit well inside one small bounded body.
const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});
const CreateInput = Schema.toCodecJson(CreateKeywordRuleInput);
const UpdateInput = Schema.toCodecJson(UpdateKeywordRuleInput);
type Subject = TransactionCaller;

const jsonResponse = (body: string, status: number): Response =>
  new Response(body, { headers: keywordRuleJsonHeaders, status });

/** The declared validation failure for a body this route cannot decode. Nothing is audited. */
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

/** A rule id that cannot be a stable rule identity never resolves to one of the caller's rules. */
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

/**
 * Decode one bounded keyword-rule payload: `update` selects the update shape rather than the
 * create shape, and None means the request carried no decodable JSON body. The result is an
 * attempted input, never authority — nothing here authenticates or audits the request.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const keywordRuleInput = (
  request: Request,
  update: boolean
): Promise<Option.Option<CreateKeywordRuleInput>> => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
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

/** The stable rule identity one retained-rule path addresses, or None for a malformed path. */
export const keywordRuleIdFromPath = (request: Request): Option.Option<KeywordRuleId> =>
  pathId({ schema: KeywordRuleId, request });

/** One keyword-rule dependency failure the owner's prepare seams classify as unavailable. */
class KeywordRuleBoundaryFailure extends Data.TaggedError("KeywordRuleBoundaryFailure")<{}> {}

/** The guarded rule change and its live-authority validation Audit, in the unit's own order. */
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
  const pat = isPATCaller(subject);
  return [
    ...(pat
      ? [prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) })]
      : []),
    statement,
    prepareOwnedStatement({
      db,
      statement: pat
        ? recordCanonicalPATWork({
            subject,
            input: {
              id: uuid(),
              current,
              operation,
              outcome: "accepted",
              afterOwnerWrite: true,
            },
          })
        : recordBrowserKeywordRuleWork({ subject, operation, id: uuid(), current }),
    }),
  ];
};

type RuleWrite = Readonly<{
  db: D1Database;
  subject: Subject;
  outcome: KeywordRuleOutcome;
  statement: D1PreparedStatement;
  current: number;
}>;

/** The guarded rule change and its live-authority audit as one prepared canonical mutation. */
const preparedRuleWrite = (write: RuleWrite): CanonicalMutationPreparation => ({
  _tag: "Prepared",
  mutation: {
    requiredScope: callerScope(write.subject),
    guardRefusal: keywordRuleGuardFor(write.outcome),
    outcome: write.outcome,
    auditBudget: "shared",
    commitGuards:
      write.outcome.operation === "categories.createKeywordRule"
        ? Option.some(({ db, userId, index, operation }) => [
            db
              .prepare(`INSERT INTO canonical_child_guard
          (child_index,operation,accepted,capacity_ok)
          SELECT ?,?,1,CASE WHEN (SELECT count(*) FROM keyword_rules WHERE user_id = ?) < ?
            THEN 1 ELSE 0 END
          ON CONFLICT(child_index) DO UPDATE SET operation = excluded.operation,
            accepted = excluded.accepted, capacity_ok = excluded.capacity_ok`)
              .bind(index, operation, userId, maximumKeywordRulesPerUser),
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

/**
 * Decide one keyword-rule change against live caller authority, a stable Category that still
 * exists, and the caller's own retained rules. The returned statements are guard-chained writes;
 * the caller's D1 unit commits them or none of them.
 */
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
    const conflict = yield* decideKeywordRuleConflict({
      rules: stored.value,
      outcome: write.outcome,
    });
    if (Option.isSome(conflict)) {
      return refusedPreparation(
        keywordRuleRefusal({ failure: conflict.value, subject: write.subject })
      );
    }
    return preparedRuleWrite(write);
  });

const isoTimestamp = (current: number): string => DateTime.formatIso(DateTime.makeUnsafe(current));

/** Create one keyword rule for future capture only; existing Transactions stay untouched. */
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
  return prepareRuleWrite({
    db,
    subject,
    outcome: {
      _tag: "KeywordRule",
      operation: "categories.createKeywordRule",
      ruleId,
      keyword: payload.keyword,
      categoryId: payload.categoryId,
    },
    statement: prepareOwnedStatement({
      db,
      statement: insertKeywordRule({
        id: ruleId,
        userId: subject.userId,
        keyword: payload.keyword,
        normalizedKeyword: normalizeCategoryKeyword(payload.keyword),
        categoryId: payload.categoryId,
        timestamp: isoTimestamp(current),
        authority,
      }),
    }),
    current,
  }).pipe(Effect.orElseSucceed(failedPreparation));
};

/** Replace one owned keyword rule for future capture only; existing Transactions stay untouched. */
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
  return prepareRuleWrite({
    db,
    subject,
    outcome: {
      _tag: "KeywordRule",
      operation: "categories.updateKeywordRule",
      ruleId,
      keyword: payload.keyword,
      categoryId: payload.categoryId,
    },
    statement: prepareOwnedStatement({
      db,
      statement: replaceKeywordRule({
        id: ruleId,
        userId: subject.userId,
        keyword: payload.keyword,
        normalizedKeyword: normalizeCategoryKeyword(payload.keyword),
        categoryId: payload.categoryId,
        timestamp: isoTimestamp(current),
        authority,
      }),
    }),
    current,
  }).pipe(Effect.orElseSucceed(failedPreparation));
};

/** Stop applying one owned keyword rule to future capture; existing Transactions stay untouched. */
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
  return prepareRuleWrite({
    db,
    subject,
    outcome: { _tag: "KeywordRule", operation: "categories.deleteKeywordRule", ruleId },
    statement: prepareOwnedStatement({
      db,
      statement: removeKeywordRule({ id: ruleId, userId: subject.userId, authority }),
    }),
    current,
  }).pipe(Effect.orElseSucceed(failedPreparation));
};

/** The protected list read, its live-authority audit, and the caller's own rules. */
const listStatements = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: Subject }>): Array<D1PreparedStatement> => {
  const current = now();
  const pat = isPATCaller(subject);
  return [
    ...(pat
      ? [prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) })]
      : []),
    prepareOwnedStatement({
      db,
      statement: protectedKeywordRulesQuery({
        userId: subject.userId,
        authority: callerAuthority({ subject, current }),
      }),
    }),
    prepareOwnedStatement({
      db,
      statement: pat
        ? recordCanonicalPATWork({
            subject,
            input: {
              id: uuid(),
              current,
              operation: "categories.listKeywordRules",
              outcome: "accepted",
              afterOwnerWrite: false,
            },
          })
        : recordBrowserKeywordRuleRead({
            subject,
            operation: "categories.listKeywordRules",
            id: uuid(),
            current,
          }),
    }),
  ];
};

/**
 * Classify a keyword-rule credential refusal through the shared PAT/session branch, defecting to
 * this owner's unavailable answer.
 */
const refusedWork = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: Subject }>): Effect.Effect<Response> =>
  Effect.tryPromise(() => refusedTransactionWork({ db, subject })).pipe(
    Effect.orElseSucceed(keywordRuleUnavailable)
  );

/** List only the caller's own rules under a live WebSession or PAT. */
export const listOwnKeywordRules = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: Subject }>): Promise<Response> =>
  Effect.gen(function* () {
    const statements = listStatements({ db, subject });
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
  }).pipe(Effect.orElseSucceed(keywordRuleUnavailable), Effect.runPromise);
