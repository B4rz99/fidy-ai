import type { BudgetOutcome } from "../contract";
import { CategoryId } from "../../../src/core/categories/contract";
import { prepareCategoryReference, requireCategory } from "../../categories/operations";
import {
  Budget,
  BudgetId,
  type CreateBudgetInput,
  type UpdateBudgetInput,
} from "../../../src/core/budgets/contract";
import { encodeMoneyAmount } from "../../../src/core/_shared/money";
import { DateTime, Effect, Option, Schema } from "effect";
import type { OAuthMutationReview } from "../../oauth-confirmation/contract";
import { oauthMutationReview } from "../../oauth-confirmation/operations";
import {
  prepareAuthorizedAuditCall,
  prepareBrowserAuditBudgetGuard,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import { prepareOwnedStatement } from "../../database/operations";
import {
  type TransactionBoundaryFailure,
  type TransactionCaller,
  boundaryFailure,
  callerAuthority,
  callerScope,
  credentialRefusedPreparation,
  failedPreparation,
  isPATCaller,
  liveTransactionAuthority,
  refusedPreparation,
  transactionId,
} from "../../canonical-work/operations";
import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  type GuardRefusalWork,
} from "../../canonical-operations/contract";

import { budgetOutcome, budgetRefusal, findOwnedBudget } from "./budget-outcome";

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
        authority: livePATAuthority({ subject, current }),
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
          child._tag === "Owner" &&
          Option.isSome(child.guardFacts) &&
          child.guardFacts.value._tag === "Budget" &&
          child.guardFacts.value.operation === "budgets.deleteBudget" &&
          child.guardFacts.value.budgetId === outcome.budgetId
      )
    ) {
      return Effect.succeed(refusal("not_found"));
    }
    return findOwnedBudget({
      db,
      userId: subject.userId,
      id: outcome.budgetId,
    }).pipe(
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
  oauthReview,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  outcome: BudgetOutcome;
  write: D1PreparedStatement;
  current: number;
  oauthReview: Option.Option<OAuthMutationReview>;
}>): CanonicalMutationPreparation => ({
  _tag: "Prepared",
  mutation: {
    oauthReview,
    requiredScope: callerScope(subject),
    outcome: budgetOutcome(outcome),
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

const categoryExists = (
  db: D1Database,
  categoryId: string
): Effect.Effect<boolean, TransactionBoundaryFailure> =>
  requireCategory({ db, categoryId: CategoryId.make(categoryId) }).pipe(
    Effect.as(true),
    Effect.catchTag("CategoryNotFound", () => Effect.succeed(false)),
    Effect.mapError(boundaryFailure)
  );

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
    if (!(yield* categoryExists(db, categoryId))) {
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
      oauthReview: Option.none(),
      write: prepareCategoryReference({
        db,
        categoryId: payload.categoryId,
        statement: {
          sql: `INSERT INTO budgets (id, user_id, category_id, currency, cap, created_at, updated_at)
          SELECT ?, user_id, ?, ?, ?, ?, ? FROM ${authority.table} WHERE ${authority.predicate}
          AND EXISTS (SELECT 1 FROM category_reference)`,
          params: [
            id,
            payload.categoryId,
            payload.cap.currency,
            encodeMoneyAmount(payload.cap.amount),
            instant,
            instant,
            ...authority.bindings,
          ],
        },
      }),
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
    const existing = yield* findOwnedBudget({ db, userId: subject.userId, id });
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
      oauthReview: yield* reviewBudget({
        db,
        userId: subject.userId,
        budget: existing.value,
        action: "Cambiar",
      }),
      write: updateBudgetStatement({ db, subject, current, id, payload }),
    });
  }).pipe(Effect.orElseSucceed(failedPreparation));

const reviewBudget = (
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
    const existing = yield* findOwnedBudget({ db, userId: subject.userId, id });
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
      oauthReview: yield* reviewBudget({
        db,
        userId: subject.userId,
        budget: existing.value,
        action: "Eliminar",
      }),
      write: db
        .prepare(`DELETE FROM budgets WHERE user_id = ? AND id = ?
        AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
        .bind(subject.userId, id, ...authority.bindings),
    });
  }).pipe(Effect.orElseSucceed(failedPreparation));
