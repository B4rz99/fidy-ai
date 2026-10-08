import { type BudgetOutcome } from "../contract";
import { CategoryId } from "../../../src/core/categories/contract";
import { prepareCategoryReference, requireCategory } from "../../categories/operations";
import { Budget, type BudgetId, type UpdateBudgetInput } from "../../../src/core/budgets/contract";
import { encodeMoneyAmount } from "../../../src/core/_shared/money";
import { DateTime, Effect, Option, Schema } from "effect";
import { type OAuthMutationReview } from "../../oauth-confirmation/contract";
import { oauthMutationReview } from "../../oauth-confirmation/operations";
import {
  prepareAuthorizedAuditCall,
  prepareBrowserAuditBudgetGuard,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import { livePATAuthority } from "../../../src/shell/tokens/operations";
import {
  type TransactionBoundaryFailure,
  type TransactionCaller,
  boundaryFailure,
  callerAuthority,
  isPATCaller,
  liveTransactionAuthority,
  transactionId,
} from "../../canonical-work/operations";

/** The owner cap enforced by budget_capacity in migration 0016. */
const maximumBudgetsPerUser = 128;

/** Owner checks run under the same D1 lock as the child write and its Audit. */
export const budgetCommitGuards = ({
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
}>): ReadonlyArray<D1PreparedStatement> => [
  ...(browser
    ? [prepareBrowserAuditBudgetGuard({ db, owner: "budgets", userId, current, index, operation })]
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

export const budgetAudit = ({
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
    const auditStatement = recordCanonicalPATWork({
      authority: livePATAuthority({ subject, current }),
      input: {
        id: transactionId(),
        current,
        operation,
        outcome: "accepted",
        afterOwnerWrite: true,
      },
    });
    return db.prepare(auditStatement.sql).bind(...auditStatement.params);
  }
  const authority = callerAuthority({ subject, current });
  return prepareAuthorizedAuditCall({
    db,
    authority,
    id: transactionId(),
    operation,
    outcome: "accepted",
    current,
    afterOwnerWrite: true,
  });
};

export const findConflict = ({
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

export const categoryExists = ({
  db,
  categoryId,
}: Readonly<{ db: D1Database; categoryId: string }>): Effect.Effect<
  boolean,
  TransactionBoundaryFailure
> =>
  requireCategory({ db, categoryId: CategoryId.make(categoryId) }).pipe(
    Effect.as(true),
    Effect.catchTag("CategoryNotFound", () => Effect.succeed(false)),
    Effect.mapError(boundaryFailure)
  );

export const authorityReady = ({
  db,
  subject,
  current,
}: Readonly<{ db: D1Database; subject: TransactionCaller; current: number }>): Effect.Effect<
  boolean,
  TransactionBoundaryFailure
> =>
  Effect.tryPromise({
    try: () => liveTransactionAuthority({ db, subject, current }),
    catch: boundaryFailure,
  });

export const updateBudgetStatement = ({
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
  return prepareCategoryReference({
    db,
    categoryId: payload.categoryId,
    statement: {
      sql: `UPDATE budgets SET category_id = ?, cap = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND currency = ?
      AND EXISTS (SELECT 1 FROM category_reference)
      AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`,
      params: [
        payload.categoryId,
        encodeMoneyAmount(payload.cap.amount),
        instant,
        id,
        subject.userId,
        payload.cap.currency,
        ...authority.bindings,
      ],
    },
  });
};

export const reviewBudget = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    budget: Budget;
    action: "Cambiar" | "Eliminar";
  }>
): Effect.Effect<Option.Option<OAuthMutationReview>, Schema.SchemaError> =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(Budget)))(input.budget).pipe(
    Effect.map((revision) =>
      Option.some(
        oauthMutationReview({
          db: input.db,
          effect: `${input.action} el presupuesto ${input.budget.id}, categoría ${input.budget.categoryId}, límite actual ${encodeMoneyAmount(input.budget.cap.amount)} ${input.budget.cap.currency}.`,
          revision,
          guard: {
            sql: "SELECT 1 FROM budgets WHERE user_id = ? AND id = ? AND category_id = ? AND currency = ? AND cap = ? AND created_at = ? AND updated_at = ?",
            params: [
              input.userId,
              input.budget.id,
              input.budget.categoryId,
              input.budget.cap.currency,
              encodeMoneyAmount(input.budget.cap.amount),
              DateTime.formatIso(input.budget.createdAt),
              DateTime.formatIso(input.budget.updatedAt),
            ],
          },
        })
      )
    )
  );
