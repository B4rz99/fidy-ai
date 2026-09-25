import { CreateTransactionInput, encodeMoneyAmount } from "@fidy/server/transactions-runtime";
import {
  type CategoryId,
  categoryIds,
  findKeywordCategory,
  findKnownCaptureCategory,
  keywordRulesFromRows,
  keywordRulesQuery,
} from "@fidy/server/categories";
import { DateTime, Effect, Option, Schema } from "effect";
import { sessionCookie, sha256 } from "../identity/browser-login";
import { RequestBodyPolicy, boundedJsonBody } from "../http/request-body";
import {
  type TransactionBoundaryFailure,
  type TransactionCaller,
  type TransactionSubject,
  acceptedPATStatements,
  boundaryFailure,
  callerAuthority,
  callerScope,
  isPATCaller,
  maximumTransactionInputBytes,
  transactionNow as now,
  transactionId,
  transactionUnavailable,
  unauthenticatedTransaction,
} from "./transaction-boundary";
import {
  type TransactionMutationPreparation,
  executeSingleTransactionMutation,
  failedPreparation,
  refusedPreparation,
} from "./transaction-unit";

const Input = Schema.toCodecJson(CreateTransactionInput);
const UserContext = Schema.Struct({
  service_market: Schema.String,
  locale: Schema.String,
  time_zone: Schema.String,
});
const Session = Schema.Struct({ id: Schema.String, user_id: Schema.String });
const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumTransactionInputBytes,
  deadlineMilliseconds: 2000,
});

type Capture = Readonly<{
  input: typeof Input.Type;
  subject: TransactionCaller;
  context: typeof UserContext.Type;
  categoryId: CategoryId;
  id: string;
  current: number;
}>;

const sessionSubject = (raw: unknown, digest: Uint8Array): Option.Option<TransactionSubject> =>
  Option.map(Schema.decodeUnknownOption(Session)(raw), (value) => ({
    id: value.id,
    userId: value.user_id,
    digest,
  }));

/** Resolve a live WebSession on every canonical call; neither an object id nor a User id is authority. */
export const transactionSession = ({
  request,
  db,
}: {
  request: Request;
  db: D1Database;
}): Promise<Option.Option<TransactionSubject>> => {
  const cookie = sessionCookie(request);
  if (Option.isNone(cookie)) return Promise.resolve(Option.none());
  return sha256(cookie.value).then((digest) => {
    const current = now();
    return db
      .prepare(
        `SELECT id, user_id FROM web_sessions WHERE token_digest = ? AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?
      AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = web_sessions.user_id)`
      )
      .bind(digest, current, current)
      .first()
      .then((raw) => sessionSubject(raw, digest));
  });
};

/** Decode bounded canonical input before dispatching a mutation to the User coordinator. */
export const transactionInput = (request: Request): Promise<Option.Option<typeof Input.Type>> =>
  boundedJsonBody(request, policy, Input);

const captureAudit = (
  db: D1Database,
  capture: Omit<Capture, "subject"> & Readonly<{ subject: TransactionSubject }>
): D1PreparedStatement => {
  const { subject, id, current } = capture;
  return db
    .prepare(`INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
      SELECT ?, user_id, ?, 'transactions.createTransaction', 'success', ? FROM transactions WHERE user_id = ? AND id = ?
      AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = transactions.user_id)
      AND changes() = 1`)
    .bind(transactionId(), subject.id, current, subject.userId, id);
};

const captureInsert = (db: D1Database, capture: Capture): D1PreparedStatement => {
  const { input, subject, id, current, categoryId } = capture;
  const createdAt = DateTime.formatIso(DateTime.makeUnsafe(current));
  const authority = callerAuthority({ subject, current });
  return db
    .prepare(`INSERT INTO transactions (id, user_id, amount, currency, direction, counterparty, category_id, notes, occurred_at, created_at, user_decisions)
      SELECT ?, user_id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM ${authority.table} WHERE ${authority.predicate}`)
    .bind(
      id,
      encodeMoneyAmount(input.money.amount),
      input.money.currency,
      input.direction,
      Option.getOrNull(input.counterparty),
      categoryId,
      Option.getOrNull(input.notes),
      DateTime.formatIso(input.occurredAt),
      createdAt,
      Schema.encodeSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean)))({
        money: true,
        direction: true,
        occurredAt: true,
        ...(Option.isSome(input.categoryId) ? { categoryId: true } : {}),
        ...(Option.isSome(input.counterparty) ? { counterparty: true } : {}),
        ...(Option.isSome(input.notes) ? { notes: true } : {}),
      }),
      ...authority.bindings
    );
};

const captureStatements = (db: D1Database, capture: Capture): Array<D1PreparedStatement> => {
  const { subject, context, id, current } = capture;
  const createdAt = DateTime.formatIso(DateTime.makeUnsafe(current));
  return [
    captureInsert(db, capture),
    db
      .prepare(`INSERT INTO source_attestations (id, user_id, transaction_id, kind, service_market, locale, time_zone, interpretation_revision, created_at)
      SELECT ?, user_id, id, 'manual', ?, ?, ?, 'manual-v1', ? FROM transactions WHERE user_id = ? AND id = ?`)
      .bind(
        transactionId(),
        context.service_market,
        context.locale,
        context.time_zone,
        createdAt,
        subject.userId,
        id
      ),
    ...(isPATCaller(subject)
      ? acceptedPATStatements({
          db,
          subject,
          operation: "transactions.createTransaction",
          current,
        })
      : [captureAudit(db, { ...capture, subject })]),
  ];
};

const hasUnknownCategory = (db: D1Database, categoryId: Option.Option<string>): Promise<boolean> =>
  Option.isNone(categoryId)
    ? Promise.resolve(false)
    : db
        .prepare("SELECT id FROM categories WHERE id = ?")
        .bind(categoryId.value)
        .first()
        .then((category) => category === null);

const captureUserContext = (
  db: D1Database,
  userId: string
): Effect.Effect<Option.Option<typeof UserContext.Type>, TransactionBoundaryFailure> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare("SELECT service_market, locale, time_zone FROM users WHERE id = ?")
        .bind(userId)
        .first(),
    catch: boundaryFailure,
  }).pipe(Effect.map(Schema.decodeUnknownOption(UserContext)));

/**
 * The Category a capture falls back to when neither an explicit choice nor a User keyword rule
 * decided it. It reads no User state, so it stays the last step of the precedence.
 */
const fallbackCaptureCategory = (direction: typeof Input.Type.direction): CategoryId =>
  direction === "inflow" ? categoryIds.ingresos : categoryIds.otros;

const findRuleCategory = ({
  db,
  userId,
  counterparty,
}: Readonly<{ db: D1Database; userId: string; counterparty: string }>): Effect.Effect<
  Option.Option<CategoryId>,
  TransactionBoundaryFailure
> =>
  Effect.gen(function* () {
    const query = keywordRulesQuery({ userId });
    const stored = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(query.sql)
          .bind(...query.params)
          .all(),
      catch: boundaryFailure,
    });
    const rules = keywordRulesFromRows(stored.results);
    if (Option.isNone(rules)) {
      return yield* boundaryFailure("keyword_rules_unreadable");
    }
    return yield* findKeywordCategory({ counterparty, rules: rules.value });
  });

/** Explicit Category, then the User's keyword policy, then the direction fallback. */
const resolveCaptureCategory = ({
  db,
  subject,
  input,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  input: typeof Input.Type;
}>): Effect.Effect<CategoryId, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    const keywordRule = Option.isNone(input.counterparty)
      ? Option.none<CategoryId>()
      : yield* findRuleCategory({
          db,
          userId: subject.userId,
          counterparty: input.counterparty.value,
        });
    const known = yield* findKnownCaptureCategory({
      caller: input.categoryId,
      keywordRule,
    });
    return Option.getOrElse(known, () => fallbackCaptureCategory(input.direction));
  });

/**
 * Decide one canonical Transaction capture against live caller authority, User context, and the
 * Category taxonomy. The returned statements are guard-chained writes; the caller's D1 unit
 * commits them or none of them.
 */
export const prepareCapture = ({
  db,
  subject,
  input,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  input: typeof Input.Type;
  current: number;
}>): Effect.Effect<TransactionMutationPreparation> =>
  Effect.gen(function* () {
    if (DateTime.toEpochMillis(input.occurredAt) > current) {
      return refusedPreparation("validation_failed", "A Transaction cannot occur in the future.");
    }
    const context = yield* captureUserContext(db, subject.userId);
    if (Option.isNone(context)) return { _tag: "Unavailable" } as const;
    const unrecognizedCategory = yield* Effect.tryPromise({
      try: () => hasUnknownCategory(db, input.categoryId),
      catch: boundaryFailure,
    });
    if (unrecognizedCategory) {
      return refusedPreparation(
        "not_found",
        "The Category does not exist; correct categoryId and retry."
      );
    }
    const categoryId = yield* resolveCaptureCategory({ db, subject, input });
    const id = transactionId();
    return {
      _tag: "Prepared",
      mutation: {
        operation: "transactions.createTransaction",
        transactionId: id,
        response: { _tag: "Transaction" },
        expectedRevision: Option.none(),
        requiredScope: callerScope(subject),
        statements: captureStatements(db, {
          input,
          subject,
          context: context.value,
          categoryId,
          id,
          current,
        }),
      },
    } as const;
  }).pipe(Effect.orElseSucceed(failedPreparation));

/** Record one manual Transaction, its captured context and AuditLogEntry in one D1 atomic unit. */
export const createManualTransaction = ({
  db,
  subject,
  input,
}: {
  db: D1Database;
  subject: TransactionCaller;
  input: typeof Input.Type;
}): Promise<Response> => {
  const current = now();
  return Effect.runPromise(
    Effect.gen(function* () {
      const preparation = yield* prepareCapture({ db, subject, input, current });
      return yield* executeSingleTransactionMutation({
        db,
        subject,
        current,
        operation: "transactions.createTransaction",
        preparation,
        status: 201,
      });
    })
  ).catch(() => transactionUnavailable());
};

export { transactionUnavailable as unavailableTransaction, unauthenticatedTransaction };
