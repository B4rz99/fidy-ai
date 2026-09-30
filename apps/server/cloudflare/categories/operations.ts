import {
  Category,
  type CategoryFailure,
  CategoryId,
  CategoryNotFound,
  CreateKeywordRuleInput,
  KeywordRule,
  KeywordRuleAlreadyExists,
  KeywordRuleId,
  KeywordRuleLimitReached,
  UpdateKeywordRuleInput,
} from "../../src/core/categories/contract";
import {
  type KeywordRuleOperation,
  insertKeywordRule,
  keywordRuleFromRows,
  keywordRuleQuery,
  keywordRulesFromRows,
  protectedKeywordRulesQuery,
  recordBrowserKeywordRuleRead,
  recordBrowserKeywordRuleWork,
  removeKeywordRule,
  replaceKeywordRule,
} from "../../src/shell/categories/internal/keyword-rules";
import {
  ListCategoriesResponse,
  ListKeywordRulesResponse,
} from "../../src/shell/categories/contract";
import { NotFound, ValidationFailed } from "../../src/shell/public-http/contract";
import {
  fallbackCaptureCategory,
  findKeywordCategory,
  findKnownCaptureCategory,
  maximumKeywordRulesPerUser,
  normalizeCategoryKeyword,
} from "../../src/core/categories/operations";
import {
  livePATAuthority,
  patAtomicAssertion,
  recordCanonicalPATWork,
  recordLivePATUse,
} from "@fidy/server/tokens-operations";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import { prepareOwnedStatement } from "../atomic/operations";
import { RequestBodyPolicy, readBoundedRequestBody } from "../http/request-body";
import { pathId } from "../http/path";
import {
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  findExistingCategory,
  findOwnedKeywordRules,
  keywordRuleJsonHeaders,
} from "./internal/keyword-rule-shared";
import { decideKeywordRuleConflict } from "./internal/keyword-rule-conflict";
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
  type CanonicalMutationRefusal,
  type CommittedMutationValue,
  type GuardRefusalWork,
  type KeywordRuleOutcome,
  type OwnerOutcome,
  credentialRefusedPreparation,
  failedPreparation,
  refusedPreparation,
  unavailablePreparation,
} from "../mutations/mutation-types";
import { newId } from "../platform/operations";
import { refusedByAuditBudget } from "../audit/audit-triggers";
import { isConsentRevoked } from "../consent/operations";
import { type SuggestedOperationCaller } from "../../src/shell/_shared/suggested-operations";
import { categoryUnavailable, toApiFailure } from "../../src/shell/categories/operations";
import { dailyAuditMessage } from "../mutations/transaction-outcome";
import {
  categoryResponseFromRows,
  categoryRowsQuery,
} from "../../src/shell/categories/internal/query";
import { recordBrowserCategoryWork } from "../../src/shell/categories/internal/canonical-work";
import { liveWebSessionAuthority } from "@fidy/server/web-session";

const HTTP_OK = 200;
const maximumProjectionCategories = 32;
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
export const keywordRuleInput = ({
  request,
  update,
}: Readonly<{ request: Request; update: boolean }>): Promise<
  Option.Option<CreateKeywordRuleInput>
> => {
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
    outcome: keywordRuleOutcome(write.outcome),
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

/**
 * Commit-time Category existence condition for an owner's atomic D1 write. Compose its SQL as
 * a predicate and append its parameters in the same position; no preflight read grants existence.
 */
export const categoryExistenceGuard = (
  categoryId: string
): Readonly<{ sql: string; params: readonly [string] }> => ({
  sql: "EXISTS (SELECT 1 FROM categories WHERE id = ?)",
  params: [categoryId],
});

/** Global taxonomy existence check. D1 failures reject instead of masquerading as absence. */
export const categoryExists = ({
  db,
  categoryId,
}: Readonly<{ db: D1Database; categoryId: string }>): Promise<boolean> =>
  db
    .prepare("SELECT 1 FROM categories WHERE id = ?")
    .bind(categoryId)
    .first()
    .then((row) => row !== null);

type CaptureCategoryInput = Readonly<{
  caller: Option.Option<CategoryId>;
  counterparty: Option.Option<string>;
  direction: "inflow" | "outflow";
}>;

/**
 * Prepare a bounded snapshot of one User's categorization policy for a capture or admitted chunk.
 * Rules remain private. Explicit choice wins over the longest keyword match, then direction fallback.
 * A later capture must prepare again to observe rule changes; this never changes retained history.
 */
export const prepareCategorization = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Effect.Effect<
  (input: CaptureCategoryInput) => Effect.Effect<CategoryId>,
  CategoryDataUnavailable
> =>
  Effect.gen(function* () {
    const stored = yield* Effect.tryPromise({
      try: () => findOwnedKeywordRules({ db, userId }),
      catch: () => new CategoryDataUnavailable(),
    });
    const rules = yield* Effect.fromOption(stored, () => new CategoryDataUnavailable());
    return (input: CaptureCategoryInput) =>
      Effect.gen(function* () {
        const keywordRule = Option.isSome(input.counterparty)
          ? yield* findKeywordCategory({ counterparty: input.counterparty.value, rules })
          : Option.none<CategoryId>();
        return Option.getOrElse(
          yield* findKnownCaptureCategory({ caller: input.caller, keywordRule }),
          () => fallbackCaptureCategory(input.direction)
        );
      });
  });

/** Category persistence could not establish a trustworthy answer. */
export class CategoryDataUnavailable extends Data.TaggedError("CategoryDataUnavailable")<{}> {}

/** Categorize one capture. Without a Counterparty no rule lookup is needed. */
export const categorizeCapture = (
  input: CaptureCategoryInput & Readonly<{ db: D1Database; userId: string }>
): Effect.Effect<CategoryId, CategoryDataUnavailable> =>
  Option.isNone(input.counterparty)
    ? Effect.succeed(Option.getOrElse(input.caller, () => fallbackCaptureCategory(input.direction)))
    : Effect.flatMap(prepareCategorization(input), (categorize) => categorize(input));

/**
 * Prepare bounded Category choices for an owner's D1 read batch. The owner executes the prepared
 * statement in its unit, then decodes the returned rows; malformed or oversized projections are None.
 */
export const prepareCategoryRead = ({
  db,
  userId: _userId,
}: Readonly<{ db: D1Database; userId: string }>): Readonly<{
  statement: D1PreparedStatement;
  decode: (rows: unknown) => Option.Option<ReadonlyArray<Category>>;
}> => ({
  statement: db.prepare(
    `SELECT id, label FROM categories ORDER BY display_order LIMIT ${maximumProjectionCategories}`
  ),
  decode: Schema.decodeUnknownOption(
    Schema.Array(Category).check(Schema.isMaxLength(maximumProjectionCategories))
  ),
});

/** Bounded Category choices for another owner, in presentation order, decoded before use. */
export const listCategoryProjection = (
  input: Readonly<{ db: D1Database; userId: string }>
): Effect.Effect<Option.Option<ReadonlyArray<Category>>> =>
  Effect.gen(function* () {
    const read = prepareCategoryRead(input);
    const rows = yield* Effect.tryPromise({
      try: () => read.statement.all(),
      catch: () => new CategoryDataUnavailable(),
    });
    return read.decode(rows.results);
  }).pipe(Effect.orElseSucceed(() => Option.none()));

/** Check all distinct Category references from a bounded caller document; D1 failures stay unavailable. */
export const checkCategories = ({
  db,
  userId: _userId,
  categoryIds,
}: Readonly<{ db: D1Database; userId: string; categoryIds: ReadonlyArray<string> }>): Effect.Effect<
  Option.Option<boolean>
> => {
  const ids = [...new Set(categoryIds)];
  if (ids.length === 0) return Effect.succeedSome(true);
  return Effect.tryPromise(() =>
    db
      .prepare(`SELECT id FROM categories WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all()
  ).pipe(
    Effect.map((rows) =>
      Option.map(
        Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ id: CategoryId })))(rows.results),
        (found) => found.length === ids.length
      )
    ),
    Effect.orElseSucceed(() => Option.none())
  );
};

/** Require one stable Category. Absence is actionable; unreadable persistence is unavailable. */
export const requireCategory = ({
  db,
  userId: _userId,
  categoryId,
}: Readonly<{
  db: D1Database;
  userId: string;
  categoryId: string;
}>): Effect.Effect<Category, CategoryNotFound | CategoryDataUnavailable> =>
  Effect.gen(function* () {
    const id = yield* Effect.fromOption(
      Schema.decodeOption(CategoryId)(categoryId),
      () => new CategoryDataUnavailable()
    );
    const raw = yield* Effect.tryPromise({
      try: () => db.prepare("SELECT id, label FROM categories WHERE id = ?").bind(id).first(),
      catch: () => new CategoryDataUnavailable(),
    });
    if (raw === null) return yield* new CategoryNotFound({ categoryId: id });
    return yield* Effect.fromOption(
      Schema.decodeUnknownOption(Category)(raw),
      () => new CategoryDataUnavailable()
    );
  });

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

/** The rule owner supplies readback, conflict replay, and its own trigger refusals. */
export const keywordRuleOutcome = (outcome: KeywordRuleOutcome): OwnerOutcome => ({
  _tag: "Owner",
  operation: outcome.operation,
  guardFacts: Option.some(outcome),
  collisionKey: Option.some(`keyword-rule:${outcome.ruleId}`),
  read: (db, userId) => findKeywordRuleValue({ db, userId, outcome }),
  triggerRefusal: ({ subject }, kind) => {
    if (kind === "capacity") {
      return Option.some(
        keywordRuleRefusal({
          failure: new KeywordRuleLimitReached({ maximum: maximumKeywordRulesPerUser }),
          subject,
        })
      );
    }
    return kind === "audit" ? Option.some(keywordRuleBudgetRefusal()) : Option.none();
  },
});

const headers = { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" };
const unavailable = (): Response => Response.json(categoryUnavailable(), { status: 503, headers });
const unauthenticated = (): Response =>
  Response.json(
    {
      error: { code: "unauthenticated", message: "Present a valid credential and retry." },
      next: [],
    },
    { status: 401, headers }
  );
const userActionRequired = (): Response =>
  Response.json(
    {
      error: {
        code: "user_action_required",
        message: "Return to Fidy to review your withdrawn Consent.",
      },
      next: [],
    },
    { status: 403, headers }
  );

const categoryStatements = (
  db: D1Database,
  subject: TransactionCaller,
  current: number
): Array<D1PreparedStatement> => {
  if (isPATCaller(subject)) {
    return [
      prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) }),
      prepareOwnedStatement({
        db,
        statement: categoryRowsQuery(livePATAuthority({ subject, current })),
      }),
      prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          subject,
          input: {
            id: uuid(),
            current,
            operation: "categories.listCategories",
            outcome: "accepted",
            afterOwnerWrite: false,
          },
        }),
      }),
    ];
  }
  return [
    prepareOwnedStatement({
      db,
      statement: categoryRowsQuery(liveWebSessionAuthority({ subject, current })),
    }),
    prepareOwnedStatement({
      db,
      statement: recordBrowserCategoryWork({ subject, id: uuid(), current }),
    }),
  ];
};

const refusedCategoryWork = (
  db: D1Database,
  subject: TransactionCaller
): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    if (isPATCaller(subject)) {
      const withdrawn = yield* isConsentRevoked({ db, userId: subject.userId }).pipe(
        Effect.mapError(() => undefined)
      );
      if (withdrawn) return userActionRequired();
    }
    return unauthenticated();
  });

const auditIndexFromEnd = -2;
const categoryWorkAccepted = (results: ReadonlyArray<D1Result>, pat: boolean): boolean =>
  results.at(auditIndexFromEnd)?.meta.changes === 1 && (!pat || results[0]?.meta.changes === 1);

const presentCategoryWork = (
  db: D1Database,
  subject: TransactionCaller,
  results: ReadonlyArray<D1Result>
): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const pat = isPATCaller(subject);
    if (!categoryWorkAccepted(results, pat)) {
      return yield* refusedCategoryWork(db, subject);
    }
    const rows = results[pat ? 1 : 0]?.results;
    const response = categoryResponseFromRows(rows);
    if (Option.isNone(response)) return unavailable();
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(ListCategoriesResponse))(
      response.value
    );
    return new Response(body, { status: 200, headers });
  });

/** Query, live authority and shared User budget commit in one D1 unit for either credential. */
export const executeProtectedCategories = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: TransactionCaller }>): Promise<Response> =>
  Effect.gen(function* () {
    const results = yield* Effect.tryPromise({
      try: () => db.batch([...categoryStatements(db, subject, now()), db.prepare(patAtomicAssertion)]),
      catch: () => undefined,
    });
    return yield* presentCategoryWork(db, subject, results);
  }).pipe(Effect.orElseSucceed(unavailable), Effect.runPromise);
