import { prepareGroupCurrency } from "./group-currency";
import { type BudgetOutcome } from "../contract";
import { CategoryId } from "../../../src/core/categories/contract";
import { prepareCategoryReference, requireCategory } from "../../categories/operations";
import {
  Budget,
  type BudgetId,
  type CreateBudgetInput,
  type UpdateBudgetInput,
} from "../../../src/core/budgets/contract";
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

export const createBudgetStatement = ({
  db,
  subject,
  current,
  id,
  payload,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  id: BudgetId;
  payload: CreateBudgetInput;
}>): D1PreparedStatement => {
  const authority = callerAuthority({ subject, current });
  const instant = DateTime.formatIso(DateTime.makeUnsafe(current));
  return prepareCategoryReference({
    db,
    categoryId: payload.categoryId,
    statement: {
      sql: `INSERT INTO budgets (id, user_id, category_id, currency, cap, created_at, updated_at, group_name, starts_month)
          SELECT ?, user_id, ?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, '') FROM ${authority.table} WHERE ${authority.predicate}
          AND EXISTS (SELECT 1 FROM category_reference)`,
      params: [
        id,
        payload.categoryId,
        payload.cap.currency,
        encodeMoneyAmount(payload.cap.amount),
        instant,
        instant,
        payload.groupName ?? "",
        payload.month ?? "",
        ...authority.bindings,
      ],
    },
  });
};

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
      sql: `UPDATE budgets SET category_id = ?, cap = CASE WHEN ? = '' THEN ? ELSE cap END,
      group_name = COALESCE(NULLIF(?, ''), group_name),
      starts_month = CASE WHEN ? <> '' AND starts_month > ? THEN ? ELSE starts_month END, updated_at = ?
      WHERE id = ? AND user_id = ?
      AND EXISTS (SELECT 1 FROM category_reference)
      AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`,
      params: [
        payload.categoryId,
        payload.month ?? "",
        encodeMoneyAmount(payload.cap.amount),
        payload.groupName ?? "",
        payload.month ?? "",
        payload.month ?? "",
        payload.month ?? "",
        instant,
        id,
        subject.userId,
        ...authority.bindings,
      ],
    },
  });
};

/** Freeze all inherited caps before changing one month; these statements share the canonical write unit. */
export const prepareMonthlyPlan = ({
  db,
  subject,
  current,
  month,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  month: string;
}>): ReadonlyArray<D1PreparedStatement> => {
  const authority = callerAuthority({ subject, current });
  return [
    db
      .prepare(`INSERT INTO budget_month_caps(user_id,budget_id,month,cap)
      SELECT b.user_id,b.id,?,COALESCE((SELECT p.cap FROM budget_month_caps p
        WHERE p.user_id=b.user_id AND p.budget_id=b.id AND p.month < ?
        ORDER BY p.month DESC LIMIT 1),b.cap)
      FROM budgets b WHERE b.user_id=? AND (b.starts_month IS NULL OR b.starts_month<=?)
        AND NOT EXISTS(SELECT 1 FROM budget_plan_months WHERE user_id=? AND month=?)
        AND EXISTS(SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
      ON CONFLICT(user_id,budget_id,month) DO NOTHING`)
      .bind(month, month, subject.userId, month, subject.userId, month, ...authority.bindings),
    db
      .prepare(`INSERT INTO budget_plan_months(user_id,month)
      SELECT ?,? WHERE EXISTS(SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
      ON CONFLICT(user_id,month) DO NOTHING`)
      .bind(subject.userId, month, ...authority.bindings),
  ];
};

/** Rename the explicitly selected, caller-owned category collection in the same canonical unit. */
export const prepareBudgetGroup = ({
  db,
  subject,
  current,
  payload,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  payload: UpdateBudgetInput;
}>): ReadonlyArray<D1PreparedStatement> => {
  if (payload.groupCategoryIds === undefined || payload.groupName === undefined) return [];
  const authority = callerAuthority({ subject, current });
  return [
    db
      .prepare(`UPDATE budgets SET group_name=?,updated_at=? WHERE user_id=?
    AND category_id IN (${payload.groupCategoryIds.map(() => "?").join(",")})
    AND EXISTS(SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
      .bind(
        payload.groupName,
        DateTime.formatIso(DateTime.makeUnsafe(current)),
        subject.userId,
        ...payload.groupCategoryIds,
        ...authority.bindings
      ),
  ];
};

export const prepareMonthlyCap = ({
  db,
  subject,
  current,
  id,
  payload,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  id: BudgetId;
  payload: UpdateBudgetInput;
}>): ReadonlyArray<D1PreparedStatement> => {
  if (payload.month === undefined) return [];
  const authority = callerAuthority({ subject, current });
  return [
    db
      .prepare(`INSERT INTO budget_month_caps(user_id,budget_id,month,cap)
    SELECT user_id,id,?,? FROM budgets WHERE user_id=? AND id=?
      AND EXISTS(SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
    ON CONFLICT(user_id,budget_id,month) DO UPDATE SET cap=excluded.cap`)
      .bind(
        payload.month,
        encodeMoneyAmount(payload.cap.amount),
        subject.userId,
        id,
        ...authority.bindings
      ),
  ];
};

const groupReview = ({
  db,
  userId,
  groupIds,
}: Readonly<{
  db: D1Database;
  userId: string;
  groupIds: ReadonlyArray<CategoryId>;
}>): Effect.Effect<
  Readonly<{ groupSql: string; groupRevision: string }>,
  TransactionBoundaryFailure
> =>
  Effect.gen(function* () {
    const groupSql =
      groupIds.length === 0
        ? ""
        : ` AND (SELECT json_array(COALESCE((SELECT revision FROM budget_user_versions WHERE user_id=budgets.user_id),0),json_group_array(json_array(id,group_name,updated_at))) FROM (SELECT user_id,id,group_name,updated_at FROM budgets WHERE user_id=? AND category_id IN (${groupIds.map(() => "?").join(",")}) ORDER BY id) budgets) = ?`;
    const groupRevision =
      groupIds.length === 0
        ? ""
        : yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `SELECT json_array(COALESCE((SELECT revision FROM budget_user_versions WHERE user_id=budgets.user_id),0),json_group_array(json_array(id,group_name,updated_at))) AS revision FROM (SELECT user_id,id,group_name,updated_at FROM budgets WHERE user_id=? AND category_id IN (${groupIds.map(() => "?").join(",")}) ORDER BY id) budgets`
                )
                .bind(userId, ...groupIds)
                .first<string>("revision")
                .then((value) => value ?? ""),
            catch: boundaryFailure,
          });
    return { groupSql, groupRevision };
  });

export const reviewBudget = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    budget: Budget;
    action: "Cambiar" | "Eliminar";
    groupCategoryIds: Option.Option<ReadonlyArray<CategoryId>>;
  }>
): Effect.Effect<
  Option.Option<OAuthMutationReview>,
  Schema.SchemaError | TransactionBoundaryFailure
> =>
  Effect.gen(function* () {
    const groupIds = Option.getOrElse(input.groupCategoryIds, () => []);
    const { groupSql, groupRevision } = yield* groupReview({
      db: input.db,
      userId: input.userId,
      groupIds,
    });
    return yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(Budget)))(
      input.budget
    ).pipe(
      Effect.map((revision) =>
        Option.some(
          oauthMutationReview({
            db: input.db,
            effect: `${input.action} ${groupIds.length === 0 ? "el presupuesto" : `el grupo de ${groupIds.length} categorías y el presupuesto`} ${input.budget.id}, categoría ${input.budget.categoryId}, límite actual ${encodeMoneyAmount(input.budget.cap.amount)} ${input.budget.cap.currency}.`,
            revision:
              groupIds.length === 0
                ? revision
                : JSON.stringify({ budget: revision, group: groupRevision }),
            guard: {
              sql:
                "SELECT 1 FROM budgets WHERE user_id = ? AND id = ? AND category_id = ? AND COALESCE((SELECT g.currency FROM budget_group_currencies g WHERE g.user_id=budgets.user_id AND g.group_name=budgets.group_name ORDER BY g.month DESC LIMIT 1),currency) = ? AND cap = ? AND created_at = ? AND updated_at = ?" +
                groupSql,
              params: [
                input.userId,
                input.budget.id,
                input.budget.categoryId,
                input.budget.cap.currency,
                encodeMoneyAmount(input.budget.cap.amount),
                DateTime.formatIso(input.budget.createdAt),
                DateTime.formatIso(input.budget.updatedAt),
                ...(groupIds.length === 0 ? [] : [input.userId, ...groupIds, groupRevision]),
              ],
            },
          })
        )
      )
    );
  });

/** Freeze inherited plans, revise the selected cap, and rename only the explicitly owned collection. */
export const prepareBudgetMonthUpdate = (
  input: Readonly<{
    db: D1Database;
    subject: TransactionCaller;
    current: number;
    id: BudgetId;
    payload: UpdateBudgetInput;
  }>
): ReadonlyArray<D1PreparedStatement> => [
  ...(input.payload.month === undefined
    ? []
    : prepareMonthlyPlan({ ...input, month: input.payload.month })),
  ...prepareMonthlyCap(input),
  ...prepareGroupCurrency(input),
  ...prepareBudgetGroup(input),
];
