import {
  type CategoryFailure,
  type CategoryId,
  type CategoryKeyword,
  CategoryNotFound,
  CreateKeywordRuleInput,
  type KeywordRule,
  KeywordRuleAlreadyExists,
  KeywordRuleId,
  KeywordRuleLimitReached,
  KeywordRuleNotFound,
  type KeywordRuleOperation,
  KeywordRuleResponse,
  ListKeywordRulesResponse,
  NotFound,
  RemovedKeywordRuleResponse,
  type SuggestedOperationCaller,
  UpdateKeywordRuleInput,
  ValidationFailed,
  canCreateKeywordRule,
  categoryMutationCompletion,
  hasKeywordRule,
  insertKeywordRule,
  keywordRuleFromRows,
  keywordRuleQuery,
  keywordRulesFromRows,
  keywordRulesQuery,
  maximumKeywordRulesPerUser,
  normalizeCategoryKeyword,
  protectedKeywordRulesQuery,
  recordBrowserKeywordRuleRead,
  recordBrowserKeywordRuleWork,
  removeKeywordRule,
  replaceKeywordRule,
  toApiFailure,
} from "@fidy/server/categories";
import { recordCanonicalPATWork, recordLivePATUse } from "@fidy/server/tokens-runtime";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import { prepareOwnedStatement } from "../pats/pat-unit";
import { RequestBodyPolicy, readBoundedRequestBody } from "../http/request-body";
import {
  type TransactionCaller,
  callerAuthority,
  isPATCaller,
  liveTransactionAuthority,
  transactionNow as now,
  refusedPATWork,
  transactionFailure,
  transactionUnavailable as unavailable,
  transactionId as uuid,
} from "../transactions/transaction-boundary";

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
// The completion assertion always closes the batch, so the audit sits one before it.
const auditFromEnd = -2;
const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;
// A keyword, a CategoryId, and the JSON envelope fit well inside one small bounded body.
const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});
const CreateInput = Schema.toCodecJson(CreateKeywordRuleInput);
const UpdateInput = Schema.toCodecJson(UpdateKeywordRuleInput);
type Subject = TransactionCaller;
type Rules = ReadonlyArray<KeywordRule>;
type RulePayload = Readonly<{ keyword: CategoryKeyword; categoryId: CategoryId }>;

class KeywordRuleBoundaryFailure extends Data.TaggedError("KeywordRuleBoundaryFailure")<{}> {}
const waitFor = <A>(run: () => Promise<A>): Effect.Effect<A, KeywordRuleBoundaryFailure> =>
  Effect.tryPromise({ try: run, catch: () => new KeywordRuleBoundaryFailure() });

const jsonResponse = (body: string, status: number): Response =>
  new Response(body, { headers: jsonHeaders, status });

const refusedWork = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: Subject }>): Effect.Effect<Response> =>
  isPATCaller(subject)
    ? Effect.tryPromise({
        try: () => refusedPATWork({ db, userId: subject.userId }),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(unavailable))
    : Effect.succeed(
        transactionFailure({
          code: "unauthenticated",
          status: 401,
          message: "Present a valid credential and retry.",
        })
      );

/** Caller facts for suggestion policy. Every recovery target is a Free read, so tier never filters. */
const suggestionCaller = (subject: Subject): SuggestedOperationCaller =>
  isPATCaller(subject)
    ? {
        accessCaller: { _tag: "PAT", capabilities: Option.toArray(subject.requiredScope) },
        tier: "free",
      }
    : { accessCaller: { _tag: "WebSession", fresh: false }, tier: "free" };

const declareFailure = (failure: ReturnType<typeof toApiFailure>): Response =>
  failure._tag === "NotFound"
    ? jsonResponse(
        JSON.stringify(Schema.encodeSync(Schema.toCodecJson(NotFound))(failure)),
        HTTP_NOT_FOUND
      )
    : jsonResponse(
        JSON.stringify(Schema.encodeSync(Schema.toCodecJson(ValidationFailed))(failure)),
        HTTP_BAD_REQUEST
      );

const failureResponse = (failure: CategoryFailure, subject: Subject): Response =>
  declareFailure(toApiFailure({ failure, caller: suggestionCaller(subject) }));

const invalidInput = (): Response =>
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
const unknownRule = (): Response =>
  declareFailure(
    NotFound.make({
      error: {
        code: "not_found",
        message: "No keyword rule with that id belongs to you.",
      },
      next: [],
    })
  );

const ruleInput = (request: Request, update: boolean): Promise<Option.Option<RulePayload>> => {
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

const ruleIdFromPath = (request: Request): Option.Option<KeywordRuleId> =>
  Option.flatMap(Option.fromUndefinedOr(new URL(request.url).pathname.split("/").at(-1)), (raw) =>
    Schema.decodeOption(KeywordRuleId)(raw)
  );

const loadRules = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Promise<Rules> => {
  const query = keywordRulesQuery({ userId });
  return db
    .prepare(query.sql)
    .bind(...query.params)
    .all()
    .then((result) => {
      const decoded = keywordRulesFromRows(result.results);
      if (Option.isNone(decoded)) throw new KeywordRuleBoundaryFailure();
      return decoded.value;
    });
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

type RefusalFacts = Readonly<{
  db: D1Database;
  subject: Subject;
  current: number;
  ruleId: Option.Option<KeywordRuleId>;
  keyword: Option.Option<CategoryKeyword>;
  categoryId: Option.Option<CategoryId>;
  capacity: boolean;
}>;

const knownCategory = ({
  db,
  categoryId,
}: Readonly<{ db: D1Database; categoryId: CategoryId }>): Effect.Effect<
  boolean,
  KeywordRuleBoundaryFailure
> =>
  waitFor(() => db.prepare("SELECT 1 FROM categories WHERE id = ?").bind(categoryId).first()).pipe(
    Effect.map((category) => category !== null)
  );

/** The conflict a refused or raced change collided with inside the caller's own retained rules. */
const ruleConflict = ({
  db,
  subject,
  facts,
}: Readonly<{ db: D1Database; subject: Subject; facts: RefusalFacts }>): Effect.Effect<
  Option.Option<CategoryFailure>,
  KeywordRuleBoundaryFailure
> =>
  Effect.gen(function* () {
    const rules = yield* waitFor(() => loadRules({ db, userId: subject.userId }));
    const { keyword, ruleId } = facts;
    if (Option.isSome(ruleId) && !rules.some((rule) => rule.id === ruleId.value)) {
      return Option.some(new KeywordRuleNotFound({ keywordRuleId: ruleId.value }));
    }
    if (Option.isSome(keyword)) {
      const duplicate = yield* hasKeywordRule({
        keyword: keyword.value,
        rules,
        excluding: ruleId,
      });
      if (duplicate) return Option.some(new KeywordRuleAlreadyExists({ keyword: keyword.value }));
    }
    if (facts.capacity && !(yield* canCreateKeywordRule(rules))) {
      return Option.some(new KeywordRuleLimitReached({ maximum: maximumKeywordRulesPerUser }));
    }
    return Option.none();
  });

/** The reason a refused or raced change produced no effect, if any explains it. */
const refusalReason = (
  facts: RefusalFacts
): Effect.Effect<Option.Option<CategoryFailure | "unauthorized">, KeywordRuleBoundaryFailure> =>
  Effect.gen(function* () {
    const { db, subject, categoryId } = facts;
    const live = yield* waitFor(() =>
      liveTransactionAuthority({ db, subject, current: facts.current })
    );
    if (!live) return Option.some("unauthorized" as const);
    if (Option.isSome(categoryId)) {
      const exists = yield* knownCategory({ db, categoryId: categoryId.value });
      if (!exists) return Option.some(new CategoryNotFound({ categoryId: categoryId.value }));
    }
    return yield* ruleConflict({ db, subject, facts });
  });

const classifyRefusal = (facts: RefusalFacts): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const reason = yield* refusalReason(facts);
    if (Option.isNone(reason)) return unavailable();
    if (reason.value === "unauthorized") {
      return yield* refusedWork({ db: facts.db, subject: facts.subject });
    }
    return failureResponse(reason.value, facts.subject);
  }).pipe(Effect.orElseSucceed(unavailable));

type RuleWrite = Readonly<{
  db: D1Database;
  subject: Subject;
  operation: KeywordRuleOperation;
  ruleId: KeywordRuleId;
  statement: D1PreparedStatement;
  facts: RefusalFacts;
}>;

const committedResponse = ({
  db,
  subject,
  operation,
  ruleId,
}: Omit<RuleWrite, "statement" | "facts">): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (operation === "categories.deleteKeywordRule") {
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(RemovedKeywordRuleResponse))({
        data: ruleId,
        next: [],
      });
      return jsonResponse(body, HTTP_OK);
    }
    const rule = yield* waitFor(() => findOwnedRule({ db, userId: subject.userId, id: ruleId }));
    if (Option.isNone(rule)) return unavailable();
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(KeywordRuleResponse))({
      data: rule.value,
      next: [],
    });
    return jsonResponse(
      body,
      operation === "categories.createKeywordRule" ? HTTP_CREATED : HTTP_OK
    );
  }).pipe(Effect.orElseSucceed(unavailable));

/** The guarded rule change, its live-authority audit, and the rollback assertion in one unit. */
const writeStatements = ({
  db,
  subject,
  operation,
  statement,
  current,
}: Omit<RuleWrite, "ruleId" | "facts"> &
  Readonly<{ current: number }>): Array<D1PreparedStatement> => {
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
    db.prepare(categoryMutationCompletion),
  ];
};

const presentWriteResult = (
  write: RuleWrite,
  results: ReadonlyArray<D1Result>
): Effect.Effect<Response> => {
  const { db, subject, operation, ruleId, facts } = write;
  if (results.at(auditFromEnd)?.meta.changes !== 1) return classifyRefusal(facts);
  if (isPATCaller(subject) && results[0]?.meta.changes !== 1) return refusedWork({ db, subject });
  return committedResponse({ db, subject, operation, ruleId });
};

/** Commit one guarded rule write with its live-authority audit in a single D1 unit. */
const commitRuleWrite = (write: RuleWrite): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const result = yield* waitFor(() =>
      write.db.batch(writeStatements({ ...write, current: write.facts.current }))
    ).pipe(Effect.option);
    return yield* Option.isNone(result)
      ? classifyRefusal(write.facts)
      : presentWriteResult(write, result.value);
  });

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

/** List only the caller's own rules under a live WebSession or PAT. */
export const listOwnKeywordRules = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: Subject }>): Promise<Response> =>
  Effect.gen(function* () {
    const statements = listStatements({ db, subject });
    const results = yield* waitFor(() => db.batch(statements));
    const auditAccepted =
      results.at(-1)?.meta.changes === 1 &&
      (!isPATCaller(subject) || results[0]?.meta.changes === 1);
    if (!auditAccepted) return yield* refusedWork({ db, subject });
    const rules = keywordRulesFromRows(results.at(auditFromEnd)?.results);
    if (Option.isNone(rules)) return unavailable();
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(ListKeywordRulesResponse))({
      data: rules.value,
      next: [],
    });
    return jsonResponse(body, HTTP_OK);
  }).pipe(Effect.orElseSucceed(unavailable), Effect.runPromise);

/** Create one keyword rule for future capture only; existing Transactions stay untouched. */
export const createOwnKeywordRule = ({
  request,
  db,
  subject,
}: Readonly<{ request: Request; db: D1Database; subject: Subject }>): Promise<Response> =>
  Effect.gen(function* () {
    const input = yield* waitFor(() => ruleInput(request, false));
    if (Option.isNone(input)) return invalidInput();
    const current = now();
    const authority = callerAuthority({ subject, current });
    const ruleId = yield* Schema.decodeEffect(KeywordRuleId)(uuid());
    return yield* commitRuleWrite({
      db,
      subject,
      operation: "categories.createKeywordRule",
      ruleId,
      statement: prepareOwnedStatement({
        db,
        statement: insertKeywordRule({
          id: ruleId,
          userId: subject.userId,
          keyword: input.value.keyword,
          normalizedKeyword: normalizeCategoryKeyword(input.value.keyword),
          categoryId: input.value.categoryId,
          timestamp: DateTime.formatIso(DateTime.makeUnsafe(current)),
          authority,
        }),
      }),
      facts: {
        db,
        subject,
        current,
        ruleId: Option.none(),
        keyword: Option.some(input.value.keyword),
        categoryId: Option.some(input.value.categoryId),
        capacity: true,
      },
    });
  }).pipe(Effect.orElseSucceed(unavailable), Effect.runPromise);

/** Replace one owned keyword rule for future capture only; existing Transactions stay untouched. */
export const updateOwnKeywordRule = ({
  request,
  db,
  subject,
}: Readonly<{ request: Request; db: D1Database; subject: Subject }>): Promise<Response> =>
  Effect.gen(function* () {
    const ruleId = ruleIdFromPath(request);
    if (Option.isNone(ruleId)) return unknownRule();
    const input = yield* waitFor(() => ruleInput(request, true));
    if (Option.isNone(input)) return invalidInput();
    const current = now();
    const authority = callerAuthority({ subject, current });
    return yield* commitRuleWrite({
      db,
      subject,
      operation: "categories.updateKeywordRule",
      ruleId: ruleId.value,
      statement: prepareOwnedStatement({
        db,
        statement: replaceKeywordRule({
          id: ruleId.value,
          userId: subject.userId,
          keyword: input.value.keyword,
          normalizedKeyword: normalizeCategoryKeyword(input.value.keyword),
          categoryId: input.value.categoryId,
          timestamp: DateTime.formatIso(DateTime.makeUnsafe(current)),
          authority,
        }),
      }),
      facts: {
        db,
        subject,
        current,
        ruleId,
        keyword: Option.some(input.value.keyword),
        categoryId: Option.some(input.value.categoryId),
        capacity: false,
      },
    });
  }).pipe(Effect.orElseSucceed(unavailable), Effect.runPromise);

/** Stop applying one owned keyword rule to future capture; existing Transactions stay untouched. */
export const deleteOwnKeywordRule = ({
  request,
  db,
  subject,
}: Readonly<{ request: Request; db: D1Database; subject: Subject }>): Promise<Response> =>
  Effect.gen(function* () {
    const ruleId = ruleIdFromPath(request);
    if (Option.isNone(ruleId)) return unknownRule();
    const current = now();
    const authority = callerAuthority({ subject, current });
    return yield* commitRuleWrite({
      db,
      subject,
      operation: "categories.deleteKeywordRule",
      ruleId: ruleId.value,
      statement: prepareOwnedStatement({
        db,
        statement: removeKeywordRule({
          id: ruleId.value,
          userId: subject.userId,
          authority,
        }),
      }),
      facts: {
        db,
        subject,
        current,
        ruleId,
        keyword: Option.none(),
        categoryId: Option.none(),
        capacity: false,
      },
    });
  }).pipe(Effect.orElseSucceed(unavailable), Effect.runPromise);

/** Dispatch one authenticated rule mutation through the one adapter that owns its contract. */
export const handleOwnKeywordRuleMutation = ({
  request,
  db,
  subject,
  operation,
}: Readonly<{
  request: Request;
  db: D1Database;
  subject: Subject;
  operation: KeywordRuleOperation;
}>): Promise<Response> => {
  switch (operation) {
    case "categories.createKeywordRule":
      return createOwnKeywordRule({ request, db, subject });
    case "categories.updateKeywordRule":
      return updateOwnKeywordRule({ request, db, subject });
    case "categories.deleteKeywordRule":
      return deleteOwnKeywordRule({ request, db, subject });
  }
};
