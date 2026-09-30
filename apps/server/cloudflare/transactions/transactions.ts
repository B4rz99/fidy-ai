import { consentNotRevoked } from "@fidy/server/consent-runtime";
import { CreateTransactionInput, encodeMoneyAmount } from "@fidy/server/transactions-runtime";
import {
  type CategoryId,
  fallbackCaptureCategory,
  findKeywordCategory,
  findKnownCaptureCategory,
  keywordRulesFromRows,
  keywordRulesQuery,
} from "@fidy/server/categories";
import { DateTime, Effect, Option, Schema } from "effect";
import type { UserContext } from "../../src/core/identity/contract";
import { findUserContext } from "../identity/operations";
import { RequestBodyPolicy, boundedJsonBody } from "../http/request-body";
import {
  type TransactionBoundaryFailure,
  type TransactionCaller,
  type TransactionRefusal,
  type TransactionSubject,
  acceptedPATStatements,
  boundaryFailure,
  callerAuthority,
  callerScope,
  isPATCaller,
  maximumTransactionInputBytes,
  transactionId,
  transactionUnavailable,
  unauthenticatedTransaction,
} from "./transaction-boundary";
import {
  type CanonicalMutationPreparation,
  type PreparedCanonicalMutation,
  type TransactionOutcome,
  failedPreparation,
  unavailablePreparation,
} from "../mutations/mutation-types";
import {
  refusedTransactionMutation,
  transactionGuardRefusal,
} from "../mutations/transaction-outcome";

const Input = Schema.toCodecJson(CreateTransactionInput);
const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumTransactionInputBytes,
  deadlineMilliseconds: 2000,
});

type Capture = Readonly<{
  input: typeof Input.Type;
  subject: TransactionCaller;
  context: UserContext;
  categoryId: CategoryId;
  id: string;
  current: number;
}>;

/** Decode bounded canonical input before dispatching a mutation to the User coordinator. */
export const transactionInput = (request: Request): Promise<Option.Option<typeof Input.Type>> =>
  boundedJsonBody({ request, policy, schema: Input });

const captureAudit = (
  db: D1Database,
  capture: Omit<Capture, "subject"> & Readonly<{ subject: TransactionSubject }>
): D1PreparedStatement => {
  const { subject, id, current } = capture;
  return db
    .prepare(`INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
      SELECT ?, user_id, ?, 'transactions.createTransaction', 'success', ? FROM transactions WHERE user_id = ? AND id = ?
      AND ${consentNotRevoked("transactions.user_id")}
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
        context.serviceMarket,
        context.locale,
        context.timeZone,
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
): Effect.Effect<Option.Option<UserContext>, TransactionBoundaryFailure> =>
  findUserContext({ db, userId }).pipe(Effect.mapError(boundaryFailure));

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

/** One capture refusal built from the shared Transaction refusal vocabulary. */
const refusedCapture = ({
  db,
  subject,
  current,
  refusal,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  refusal: TransactionRefusal;
}>): CanonicalMutationPreparation =>
  refusedTransactionMutation({
    db,
    subject,
    operation: "transactions.createTransaction",
    refusal,
    current,
  });

/** The guarded writes and canonical outcome for one admitted capture. */
const captureMutation = ({
  db,
  subject,
  input,
  context,
  categoryId,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  input: typeof Input.Type;
  context: UserContext;
  categoryId: CategoryId;
  current: number;
}>): PreparedCanonicalMutation => {
  const id = transactionId();
  const outcome: TransactionOutcome = {
    _tag: "Transaction",
    operation: "transactions.createTransaction",
    transactionId: id,
    readback: { _tag: "Transaction" },
    expectedRevision: Option.none(),
  };
  return {
    requiredScope: callerScope(subject),
    guardRefusal: transactionGuardRefusal(outcome),
    outcome,
    auditBudget: "shared",
    commitGuards: Option.some(
      ({ db, userId, current, index, operation }): ReadonlyArray<D1PreparedStatement> => {
        const createdAt = DateTime.formatIso(DateTime.makeUnsafe(current));
        return [
          db
            .prepare(`INSERT INTO canonical_child_guard (child_index,operation,accepted,movement_ok)
        SELECT ?,?,1,CASE WHEN (SELECT count(*) FROM transactions
          WHERE user_id = ? AND created_at >= substr(?, 1, 10) || 'T00:00:00.000Z'
          AND created_at < date(?, '+1 day') || 'T00:00:00.000Z') < 100 THEN 1 ELSE 0 END
        ON CONFLICT(child_index) DO UPDATE SET operation = excluded.operation,
          accepted = excluded.accepted, movement_ok = excluded.movement_ok`)
            .bind(index, operation, userId, createdAt, createdAt),
        ];
      }
    ),
    statements: captureStatements(db, {
      input,
      subject,
      context,
      categoryId,
      id,
      current,
    }),
  };
};

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
}>): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    if (DateTime.toEpochMillis(input.occurredAt) > current) {
      return refusedCapture({
        db,
        subject,
        current,
        refusal: {
          outcome: "validation_failed",
          message: "A Transaction cannot occur in the future.",
        },
      });
    }
    const context = yield* captureUserContext(db, subject.userId);
    if (Option.isNone(context)) return unavailablePreparation();
    const unrecognizedCategory = yield* Effect.tryPromise({
      try: () => hasUnknownCategory(db, input.categoryId),
      catch: boundaryFailure,
    });
    if (unrecognizedCategory) {
      return refusedCapture({
        db,
        subject,
        current,
        refusal: {
          outcome: "not_found",
          message: "The Category does not exist; correct categoryId and retry.",
        },
      });
    }
    const categoryId = yield* resolveCaptureCategory({ db, subject, input });
    return {
      _tag: "Prepared",
      mutation: captureMutation({
        db,
        subject,
        input,
        context: context.value,
        categoryId,
        current,
      }),
    } as const;
  }).pipe(Effect.orElseSucceed(failedPreparation));

export { transactionUnavailable as unavailableTransaction, unauthenticatedTransaction };
