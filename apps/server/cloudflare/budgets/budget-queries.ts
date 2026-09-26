import {
  Budget,
  BudgetId,
  BudgetStatusQueryValues,
  BudgetStatusReport,
  calculateBudgetStatus,
  deriveCurrentBudgetMonth,
  sumBudgetContributions,
} from "@fidy/server/budgets-runtime";
import { Currency, Money } from "@fidy/server/transactions-runtime";
import { recordCanonicalPATWork, recordLivePATUse } from "@fidy/server/tokens-runtime";
import { DateTime, Effect, Option, Schema } from "effect";
import { prepareOwnedStatement } from "../pats/pat-unit";
import { effectiveTransactionRelation } from "../transactions/effective-transaction";
import {
  type TransactionCaller,
  boundaryFailure,
  callerAuthority,
  isPATCaller,
  liveTransactionAuthority,
  transactionFailure,
  transactionId,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../transactions/transaction-boundary";
import { budgetFromRow } from "./budget-row";

const maximumBudgetCount = 128;
const maximumMonthlyMovements = 5000;
const MovementRow = Schema.Struct({
  amount: Schema.String,
  currency: Currency,
  category_id: Budget.fields.categoryId,
  direction: Schema.Literals(["inflow", "outflow"]),
  occurred_at: Schema.String,
});
const Query = Schema.Struct({
  categoryId: Schema.optionalKey(BudgetStatusQueryValues.fields.categoryId),
  currency: Schema.optionalKey(BudgetStatusQueryValues.fields.currency),
  timeZone: BudgetStatusQueryValues.fields.timeZone,
});
type BudgetQueryOperation = "budgets.listBudgets" | "budgets.getBudget" | "budgets.getBudgetStatus";
const respond = <A>(schema: Schema.Codec<A, Schema.Json>, data: A): Response =>
  Response.json(
    { data: Schema.encodeSync(schema)(data), next: [] },
    { headers: transactionNoStore }
  );
const invalid = (): Response =>
  transactionFailure({ code: "validation_failed", status: 400, message: "Invalid Budget query." });
const missing = (): Response =>
  transactionFailure({ code: "not_found", status: 404, message: "Budget unavailable." });

/** Audit a live credential before releasing a User-owned Budget projection. */
const authorizeRead = ({
  db,
  subject,
  operation,
  outcome,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: BudgetQueryOperation;
  outcome: "accepted" | "rejected";
}>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const current = transactionNow();
    const live = yield* Effect.tryPromise({
      try: () => liveTransactionAuthority({ db, subject, current }),
      catch: boundaryFailure,
    });
    if (!live) return false;
    if (isPATCaller(subject)) {
      const audit = yield* Effect.tryPromise({
        try: () =>
          db.batch([
            prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) }),
            prepareOwnedStatement({
              db,
              statement: recordCanonicalPATWork({
                subject,
                input: {
                  id: transactionId(),
                  current,
                  operation,
                  outcome,
                  afterOwnerWrite: false,
                },
              }),
            }),
          ]),
        catch: boundaryFailure,
      });
      return audit.every((row) => row.meta.changes === 1);
    }
    const authority = callerAuthority({ subject, current });
    const audit = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(`INSERT INTO budget_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
      SELECT ?, user_id, ?, ?, ?, ? FROM ${authority.table} WHERE ${authority.predicate}`)
          .bind(transactionId(), subject.id, operation, outcome, current, ...authority.bindings)
          .run(),
      catch: boundaryFailure,
    });
    return audit.meta.changes === 1;
  }).pipe(Effect.orElseSucceed(() => false));

/** Read a bounded deterministic list; an undecodable or excess row fails closed. */
export const listOwnedBudgets = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Effect.Effect<
  Option.Option<ReadonlyArray<Budget>>
> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT id, category_id, currency, cap, created_at, updated_at
      FROM budgets WHERE user_id = ? ORDER BY currency, category_id LIMIT ${maximumBudgetCount + 1}`)
        .bind(userId)
        .all()
    );
    if (result.results.length > maximumBudgetCount) return Option.none<ReadonlyArray<Budget>>();
    const budgets: Array<Budget> = [];
    for (const raw of result.results) {
      const budget = budgetFromRow(raw);
      if (Option.isNone(budget)) return Option.none<ReadonlyArray<Budget>>();
      budgets.push(budget.value);
    }
    return Option.some(budgets);
  }).pipe(Effect.orElseSucceed(() => Option.none()));

const monthlyMovements = ({
  db,
  userId,
  from,
  to,
}: Readonly<{
  db: D1Database;
  userId: string;
  from: string;
  to: string;
}>): Effect.Effect<Option.Option<ReadonlyArray<typeof MovementRow.Type>>> =>
  Effect.gen(function* () {
    const relation = effectiveTransactionRelation(userId);
    const result = yield* Effect.tryPromise(() =>
      db
        .prepare(`WITH ${relation.sql}
      SELECT amount, currency, category_id, direction, occurred_at FROM effective_transaction
      WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ? AND direction = 'outflow'
      LIMIT ${maximumMonthlyMovements + 1}`)
        .bind(...relation.bindings, userId, from, to)
        .all()
    );
    if (result.results.length > maximumMonthlyMovements) {
      return Option.none<ReadonlyArray<typeof MovementRow.Type>>();
    }
    const movements: Array<typeof MovementRow.Type> = [];
    for (const raw of result.results) {
      const decoded = Schema.decodeUnknownOption(MovementRow)(raw);
      if (Option.isNone(decoded)) return Option.none<ReadonlyArray<typeof MovementRow.Type>>();
      movements.push(decoded.value);
    }
    return Option.some(movements);
  }).pipe(Effect.orElseSucceed(() => Option.none()));

type BudgetMovement = Parameters<typeof sumBudgetContributions>[0]["movements"][number];
const decodeMovements = (
  rows: ReadonlyArray<typeof MovementRow.Type>
): Option.Option<ReadonlyArray<BudgetMovement>> => {
  const movements: Array<BudgetMovement> = [];
  for (const row of rows) {
    const money = Schema.decodeOption(Schema.toCodecJson(Money))({
      amount: row.amount,
      currency: row.currency,
    });
    const occurredAt = DateTime.make(row.occurred_at);
    if (Option.isNone(money) || Option.isNone(occurredAt)) return Option.none();
    movements.push({
      money: money.value,
      occurredAt: occurredAt.value,
      categoryId: row.category_id,
      direction: row.direction,
    });
  }
  return Option.some(movements);
};

/** The same exact effective-Transaction totals every caller and latch decision uses. */
export const currentBudgetReport = ({
  db,
  userId,
  query,
  now,
}: Readonly<{
  db: D1Database;
  userId: string;
  query: typeof Query.Type;
  now: DateTime.Utc;
}>): Effect.Effect<Option.Option<BudgetStatusReport>> =>
  Effect.gen(function* () {
    const period = deriveCurrentBudgetMonth({
      now,
      timeZone: query.timeZone,
    });
    const budgets = yield* listOwnedBudgets({ db, userId });
    if (Option.isNone(budgets)) return Option.none<BudgetStatusReport>();
    const selected = budgets.value.filter(
      (budget) =>
        (query.categoryId === undefined || budget.categoryId === query.categoryId) &&
        (query.currency === undefined || budget.cap.currency === query.currency)
    );
    if (selected.length === 0) return Option.some({ period, statuses: [] });
    const movements = yield* monthlyMovements({
      db,
      userId,
      from: DateTime.formatIso(period.from),
      to: DateTime.formatIso(period.to),
    });
    if (Option.isNone(movements)) return Option.none<BudgetStatusReport>();
    const decoded = decodeMovements(movements.value);
    if (Option.isNone(decoded)) return Option.none<BudgetStatusReport>();
    const statuses: Array<BudgetStatusReport["statuses"][number]> = [];
    for (const budget of selected) {
      const spent = sumBudgetContributions({ budget, period, movements: decoded.value });
      statuses.push(yield* calculateBudgetStatus({ budget, spent, period }));
    }
    return Option.some({ period, statuses });
  }).pipe(Effect.orElseSucceed(() => Option.none()));

const statusParameters = (url: URL): Option.Option<typeof Query.Type> => {
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== new Set(keys).size ||
    keys.some((key) => !["categoryId", "currency", "timeZone"].includes(key))
  ) {
    return Option.none();
  }
  return Schema.decodeUnknownOption(Query)(Object.fromEntries(url.searchParams));
};

const budgetParameters = (
  operation: BudgetQueryOperation,
  url: URL
): Option.Option<{
  id: Option.Option<BudgetId>;
  query: Option.Option<typeof Query.Type>;
}> => {
  if (operation === "budgets.getBudget") {
    if (url.searchParams.size > 0) return Option.none();
    const id = Schema.decodeOption(BudgetId)(url.pathname.split("/").at(-1) ?? "");
    return Option.isSome(id) ? Option.some({ id, query: Option.none() }) : Option.none();
  }
  if (operation === "budgets.listBudgets") {
    return url.searchParams.size === 0
      ? Option.some({ id: Option.none(), query: Option.none() })
      : Option.none();
  }
  return Option.map(statusParameters(url), (query) => ({
    id: Option.none<BudgetId>(),
    query: Option.some(query),
  }));
};

const readAuthorizedBudget = ({
  db,
  subject,
  operation,
  id,
  query,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: BudgetQueryOperation;
  id: Option.Option<BudgetId>;
  query: Option.Option<typeof Query.Type>;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (operation === "budgets.getBudget") {
      const raw = yield* Effect.tryPromise(() =>
        db
          .prepare(`SELECT id, category_id, currency, cap, created_at, updated_at
      FROM budgets WHERE user_id = ? AND id = ?`)
          .bind(subject.userId, Option.getOrThrow(id))
          .first()
      );
      const found = budgetFromRow(raw);
      return Option.isSome(found) ? respond(Schema.toCodecJson(Budget), found.value) : missing();
    }
    if (operation === "budgets.listBudgets") {
      const all = yield* listOwnedBudgets({ db, userId: subject.userId });
      return Option.isSome(all)
        ? respond(Schema.toCodecJson(Schema.Array(Budget)), all.value)
        : transactionUnavailable();
    }
    const report = yield* currentBudgetReport({
      db,
      userId: subject.userId,
      query: Option.getOrThrow(query),
      now: DateTime.nowUnsafe(),
    });
    return Option.isSome(report)
      ? respond(Schema.toCodecJson(BudgetStatusReport), report.value)
      : transactionUnavailable();
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

/** Execute the three canonical Budget queries with one explicit stable User and live authority. */
export const browseBudgets = ({
  db,
  subject,
  request,
  operation,
  reconcile,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  request: Request;
  operation: BudgetQueryOperation;
  reconcile: () => Effect.Effect<boolean>;
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const parsed = budgetParameters(operation, new URL(request.url));
      const outcome = Option.isSome(parsed) ? "accepted" : "rejected";
      if (!(yield* authorizeRead({ db, subject, operation, outcome }))) {
        return transactionUnavailable();
      }
      if (Option.isNone(parsed)) return operation === "budgets.getBudget" ? missing() : invalid();
      if (!(yield* reconcile())) return transactionUnavailable();
      return yield* readAuthorizedBudget({ db, subject, operation, ...parsed.value });
    }).pipe(Effect.orElseSucceed(transactionUnavailable))
  );
