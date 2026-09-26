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
  credentialRefusedPreparation,
  failedPreparation,
  refusedPreparation,
} from "../mutations/mutation-types";
import { budgetRefusal, findOwnedBudget } from "./budget-outcome";

/** A skipped guarded write or audit aborts the entire canonical D1 unit. */
export const budgetMutationCompletion = `INSERT INTO budget_mutation_assertion (id, accepted)
  VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
  ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;

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
    statements: [
      ...(isPATCaller(subject)
        ? [prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) })]
        : []),
      write,
      budgetAudit({ db, subject, operation: outcome.operation, current }),
    ],
    completion: db.prepare(budgetMutationCompletion),
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

const checkedBudgetWrite = ({
  db,
  subject,
  current,
  categoryId,
  currency,
  exceptId,
  owned,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  categoryId: string;
  currency: string;
  exceptId: string;
  owned: boolean;
}>): Effect.Effect<Option.Option<CanonicalMutationPreparation>, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    if (!(yield* authorityReady({ db, subject, current }))) {
      return Option.some(credentialRefusedPreparation());
    }
    if (!owned) return Option.some(refusedPreparation(budgetRefusal("not_found")));
    if (
      !(yield* Effect.tryPromise({
        try: () => categoryExists(db, categoryId),
        catch: boundaryFailure,
      }))
    ) {
      return Option.some(refusedPreparation(budgetRefusal("not_found")));
    }
    if (
      yield* Effect.tryPromise({
        try: () => findConflict({ db, userId: subject.userId, categoryId, currency, exceptId }),
        catch: boundaryFailure,
      })
    ) {
      return Option.some(refusedPreparation(budgetRefusal("validation_failed")));
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
    if (Option.isNone(existing)) return refusedPreparation(budgetRefusal("not_found"));
    if (existing.value.cap.currency !== payload.cap.currency) {
      return refusedPreparation(budgetRefusal("validation_failed"));
    }
    const rejected = yield* checkedBudgetWrite({
      db,
      subject,
      current,
      categoryId: payload.categoryId,
      currency: payload.cap.currency,
      exceptId: id,
      owned: true,
    });
    if (Option.isSome(rejected)) return rejected.value;
    const authority = callerAuthority({ subject, current });
    const instant = DateTime.formatIso(DateTime.makeUnsafe(current));
    return statements({
      db,
      subject,
      current,
      outcome: { _tag: "Budget", operation: "budgets.updateBudget", budgetId: id },
      write: db
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
        ),
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
    if (Option.isNone(existing)) return refusedPreparation(budgetRefusal("not_found"));
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
