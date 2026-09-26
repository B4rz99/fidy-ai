import {
  BudgetId,
  type CreateBudgetInput,
  type UpdateBudgetInput,
} from "@fidy/server/budgets-runtime";
import { DateTime, Effect, Option } from "effect";
import { encodeMoneyAmount } from "@fidy/server/transactions-runtime";
import { recordCanonicalPATWork, recordLivePATUse } from "@fidy/server/tokens-runtime";
import { prepareOwnedStatement } from "../pats/pat-unit";
import {
  type TransactionBoundaryFailure,
  type TransactionCaller,
  boundaryFailure,
  callerAuthority,
  callerScope,
  isPATCaller,
  liveTransactionAuthority,
  transactionId,
} from "../transactions/transaction-boundary";
import {
  type BudgetOutcome,
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  type GuardRefusalWork,
  credentialRefusedPreparation,
  failedPreparation,
  refusedPreparation,
} from "../mutations/mutation-types";
import { budgetRefusal, findOwnedBudget } from "./budget-outcome";
import { dailyBudgetAuditLimit } from "./budget-audit";
import { utcDayMilliseconds } from "../atomic/daily-canonical-budget";

/** The owner cap enforced by budget_capacity in migration 0016. */
const maximumBudgetsPerUser = 128;

/** Owner checks run under the same D1 lock as the child write and its Audit. */
const budgetCommitGuards = ({
  db,
  userId,
  current,
  index,
  operation,
  browser,
}: Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  index: number;
  operation: BudgetOutcome["operation"];
  browser: boolean;
}>): ReadonlyArray<D1PreparedStatement> => {
  const day = Math.floor(current / utcDayMilliseconds) * utcDayMilliseconds;
  return [
    ...(browser
      ? [
          db
            .prepare(`INSERT INTO canonical_child_guard
      (child_index,operation,accepted,budget_ok)
      SELECT ?,?,1,CASE WHEN (SELECT count(*) FROM budget_audit WHERE user_id = ?
        AND occurred_at_ms >= ? AND occurred_at_ms < ?) < ? THEN 1 ELSE 0 END
      ON CONFLICT(child_index) DO UPDATE SET operation = excluded.operation,
        accepted = excluded.accepted, budget_ok = excluded.budget_ok`)
            .bind(index, operation, userId, day, day + utcDayMilliseconds, dailyBudgetAuditLimit),
        ]
      : []),
    ...(operation === "budgets.createBudget"
      ? [
          db
            .prepare(`INSERT INTO canonical_child_guard
      (child_index,operation,accepted,capacity_ok)
      SELECT ?,?,1,CASE WHEN (SELECT count(*) FROM budgets WHERE user_id = ?) < ?
        THEN 1 ELSE 0 END
      ON CONFLICT(child_index) DO UPDATE SET operation = excluded.operation,
        accepted = excluded.accepted, capacity_ok = excluded.capacity_ok`)
            .bind(index, operation, userId, maximumBudgetsPerUser),
        ]
      : []),
  ];
};

const budgetAudit = ({
  db,
  subject,
  operation,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: BudgetOutcome["operation"];
  current: number;
}>): D1PreparedStatement => {
  if (isPATCaller(subject)) {
    return prepareOwnedStatement({
      db,
      statement: recordCanonicalPATWork({
        subject,
        input: {
          id: transactionId(),
          current,
          operation,
          outcome: "accepted",
          afterOwnerWrite: true,
        },
      }),
    });
  }
  const authority = callerAuthority({ subject, current });
  return db
    .prepare(`INSERT INTO budget_audit (id, user_id, session_id, operation, occurred_at_ms)
    SELECT ?, user_id, ?, ?, ? FROM ${authority.table}
    WHERE ${authority.predicate} AND changes() = 1`)
    .bind(transactionId(), subject.id, operation, current, ...authority.bindings);
};

/** Explain a proved Budget completion using retained earlier children and the post-rollback owner row. */
const budgetGuardRefusal =
  (outcome: BudgetOutcome) =>
  ({
    db,
    subject,
    current,
    earlier,
  }: GuardRefusalWork): Effect.Effect<CanonicalMutationRefusal> => {
    const refusal = (code: "not_found" | "validation_failed"): CanonicalMutationRefusal =>
      budgetRefusal({ db, subject, current, operation: outcome.operation, code });
    if (outcome.operation === "budgets.createBudget") {
      return Effect.succeed(refusal("validation_failed"));
    }
    // A completed deletion disappears in the unit but reappears after rollback.
    if (
      earlier.some(
        (child) =>
          child._tag === "Budget" &&
          child.operation === "budgets.deleteBudget" &&
          child.budgetId === outcome.budgetId
      )
    ) {
      return Effect.succeed(refusal("not_found"));
    }
    return Effect.tryPromise(() =>
      findOwnedBudget({
        db,
        userId: subject.userId,
        id: outcome.budgetId,
      })
    ).pipe(
      Effect.map((owned) => refusal(Option.isNone(owned) ? "not_found" : "validation_failed")),
      Effect.orElseSucceed(() => refusal("validation_failed"))
    );
  };

const statements = ({
  db,
  subject,
  outcome,
  write,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  outcome: BudgetOutcome;
  write: D1PreparedStatement;
  current: number;
}>): CanonicalMutationPreparation => ({
  _tag: "Prepared",
  mutation: {
    requiredScope: callerScope(subject),
    outcome,
    auditBudget: isPATCaller(subject) ? "shared" : "owner",
    commitGuards: Option.some(({ db, userId, current, index }) =>
      budgetCommitGuards({
        db,
        userId,
        current,
        index,
        operation: outcome.operation,
        browser: !isPATCaller(subject),
      })
    ),
    guardRefusal: budgetGuardRefusal(outcome),
    statements: [
      ...(isPATCaller(subject)
        ? [prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) })]
        : []),
      write,
      budgetAudit({ db, subject, operation: outcome.operation, current }),
    ],
  },
});

const findConflict = ({
  db,
  userId,
  categoryId,
  currency,
  exceptId,
}: Readonly<{
  db: D1Database;
  userId: string;
  categoryId: string;
  currency: string;
  exceptId: string;
}>): Promise<boolean> =>
  db
    .prepare(
      "SELECT 1 FROM budgets WHERE user_id = ? AND category_id = ? AND currency = ? AND id <> ?"
    )
    .bind(userId, categoryId, currency, exceptId)
    .first()
    .then((row) => row !== null);

const categoryExists = (db: D1Database, categoryId: string): Promise<boolean> =>
  db
    .prepare("SELECT 1 FROM categories WHERE id = ?")
    .bind(categoryId)
    .first()
    .then((row) => row !== null);

const authorityReady = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>): Effect.Effect<boolean, TransactionBoundaryFailure> =>
  Effect.tryPromise({
    try: () => liveTransactionAuthority({ db, subject, current }),
    catch: boundaryFailure,
  });

const refuseBudget = ({
  db,
  subject,
  current,
  operation,
  code,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  operation: BudgetOutcome["operation"];
  code: "not_found" | "validation_failed";
}>): CanonicalMutationPreparation =>
  refusedPreparation(budgetRefusal({ db, subject, current, operation, code }));

const checkedBudgetWrite = ({
  db,
  subject,
  current,
  categoryId,
  currency,
  exceptId,
  owned,
  operation,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  categoryId: string;
  currency: string;
  exceptId: string;
  owned: boolean;
  operation: BudgetOutcome["operation"];
}>): Effect.Effect<Option.Option<CanonicalMutationPreparation>, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    if (!(yield* authorityReady({ db, subject, current }))) {
      return Option.some(credentialRefusedPreparation());
    }
    if (!owned) {
      return Option.some(
        refusedPreparation(budgetRefusal({ db, subject, operation, current, code: "not_found" }))
      );
    }
    if (
      !(yield* Effect.tryPromise({
        try: () => categoryExists(db, categoryId),
        catch: boundaryFailure,
      }))
    ) {
      return Option.some(
        refusedPreparation(budgetRefusal({ db, subject, operation, current, code: "not_found" }))
      );
    }
    if (
      yield* Effect.tryPromise({
        try: () => findConflict({ db, userId: subject.userId, categoryId, currency, exceptId }),
        catch: boundaryFailure,
      })
    ) {
      return Option.some(
        refusedPreparation(
          budgetRefusal({ db, subject, operation, current, code: "validation_failed" })
        )
      );
    }
    return Option.none();
  });

/** Prepare a positive cap for a known Category under this caller's live authority. */
export const prepareCreateBudget = ({
  db,
  subject,
  payload,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  payload: CreateBudgetInput;
  current: number;
}>): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const id = BudgetId.make(transactionId());
    const rejected = yield* checkedBudgetWrite({
      db,
      subject,
      current,
      categoryId: payload.categoryId,
      currency: payload.cap.currency,
      exceptId: id,
      owned: true,
      operation: "budgets.createBudget",
    });
    if (Option.isSome(rejected)) return rejected.value;
    const authority = callerAuthority({ subject, current });
    const instant = DateTime.formatIso(DateTime.makeUnsafe(current));
    return statements({
      db,
      subject,
      current,
      outcome: { _tag: "Budget", operation: "budgets.createBudget", budgetId: id },
      write: db
        .prepare(`INSERT INTO budgets (id, user_id, category_id, currency, cap, created_at, updated_at)
        SELECT ?, user_id, ?, ?, ?, ?, ? FROM ${authority.table} WHERE ${authority.predicate}
        AND EXISTS (SELECT 1 FROM categories WHERE id = ?)`)
        .bind(
          id,
          payload.categoryId,
          payload.cap.currency,
          encodeMoneyAmount(payload.cap.amount),
          instant,
          instant,
          ...authority.bindings,
          payload.categoryId
        ),
    });
  }).pipe(Effect.orElseSucceed(failedPreparation));

const updateBudgetStatement = ({
  db,
  subject,
  id,
  payload,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: BudgetId;
  payload: UpdateBudgetInput;
  current: number;
}>): D1PreparedStatement => {
  const authority = callerAuthority({ subject, current });
  const instant = DateTime.formatIso(DateTime.makeUnsafe(current));
  return db
    .prepare(`UPDATE budgets SET category_id = ?, cap = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND currency = ?
    AND EXISTS (SELECT 1 FROM categories WHERE id = ?)
    AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
    .bind(
      payload.categoryId,
      encodeMoneyAmount(payload.cap.amount),
      instant,
      id,
      subject.userId,
      payload.cap.currency,
      payload.categoryId,
      ...authority.bindings
    );
};

/** Prepare a replacement without allowing a Budget's Currency or owner to change. */
export const prepareUpdateBudget = ({
  db,
  subject,
  id,
  payload,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: BudgetId;
  payload: UpdateBudgetInput;
  current: number;
}>): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const existing = yield* Effect.tryPromise(() =>
      findOwnedBudget({ db, userId: subject.userId, id })
    );
    if (Option.isNone(existing)) {
      return refuseBudget({
        db,
        subject,
        current,
        operation: "budgets.updateBudget",
        code: "not_found",
      });
    }
    if (existing.value.cap.currency !== payload.cap.currency) {
      return refuseBudget({
        db,
        subject,
        current,
        operation: "budgets.updateBudget",
        code: "validation_failed",
      });
    }
    const rejected = yield* checkedBudgetWrite({
      db,
      subject,
      current,
      categoryId: payload.categoryId,
      currency: payload.cap.currency,
      exceptId: id,
      owned: true,
      operation: "budgets.updateBudget",
    });
    if (Option.isSome(rejected)) return rejected.value;
    return statements({
      db,
      subject,
      current,
      outcome: { _tag: "Budget", operation: "budgets.updateBudget", budgetId: id },
      write: updateBudgetStatement({ db, subject, current, id, payload }),
    });
  }).pipe(Effect.orElseSucceed(failedPreparation));

/** Prepare removal of only a caller-owned Budget and its operational monthly marks. */
export const prepareDeleteBudget = ({
  db,
  subject,
  id,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: BudgetId;
  current: number;
}>): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    if (!(yield* authorityReady({ db, subject, current }))) return credentialRefusedPreparation();
    const existing = yield* Effect.tryPromise(() =>
      findOwnedBudget({ db, userId: subject.userId, id })
    );
    if (Option.isNone(existing)) {
      return refusedPreparation(
        budgetRefusal({
          db,
          subject,
          current,
          operation: "budgets.deleteBudget",
          code: "not_found",
        })
      );
    }
    const authority = callerAuthority({ subject, current });
    return statements({
      db,
      subject,
      current,
      outcome: { _tag: "Budget", operation: "budgets.deleteBudget", budgetId: id },
      write: db
        .prepare(`DELETE FROM budgets WHERE user_id = ? AND id = ?
        AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
        .bind(subject.userId, id, ...authority.bindings),
    });
  }).pipe(Effect.orElseSucceed(failedPreparation));
