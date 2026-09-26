import { type Budget, type BudgetId } from "@fidy/server/budgets-runtime";
import { Effect, Option } from "effect";
import { recordCanonicalPATWork, recordLivePATUse } from "@fidy/server/tokens-runtime";
import { prepareOwnedStatement } from "../pats/pat-unit";
import {
  type TransactionCaller,
  callerAuthority,
  isPATCaller,
  liveTransactionAuthority,
  transactionFailure,
  transactionId,
  transactionUnavailable,
} from "../transactions/transaction-boundary";
import { budgetFromRow } from "./budget-row";
import type {
  BudgetOutcome,
  CanonicalMutationRefusal,
  CommittedMutationValue,
} from "../mutations/mutation-types";

/** One retained Budget by id and stable User; a foreign id resolves to absence. */
export const findOwnedBudget = ({
  db,
  userId,
  id,
}: Readonly<{
  db: D1Database;
  userId: string;
  id: BudgetId;
}>): Promise<Option.Option<Budget>> =>
  db
    .prepare(
      "SELECT id, category_id, currency, cap, created_at, updated_at FROM budgets WHERE user_id = ? AND id = ?"
    )
    .bind(userId, id)
    .first()
    .then(budgetFromRow);

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;

type BudgetMutationOperation = BudgetOutcome["operation"];

/** A metadata-only refusal AuditLogEntry under the same live User/PAT authority as accepted work. */
const recordBudgetRefusal = ({
  db,
  subject,
  operation,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: BudgetMutationOperation;
  current: number;
}>): Effect.Effect<"recorded" | "credential_refused" | "unavailable"> =>
  Effect.tryPromise(() => liveTransactionAuthority({ db, subject, current })).pipe(
    Effect.flatMap((live) => {
      if (!live) return Effect.succeed("credential_refused" as const);
      if (isPATCaller(subject)) {
        return Effect.tryPromise(() =>
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
                  outcome: "rejected",
                  afterOwnerWrite: false,
                },
              }),
            }),
          ])
        ).pipe(
          Effect.map((results) =>
            results.every((result) => result.meta.changes === 1)
              ? ("recorded" as const)
              : ("credential_refused" as const)
          )
        );
      }
      const authority = callerAuthority({ subject, current });
      return Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO budget_audit
        (id, user_id, session_id, operation, outcome, occurred_at_ms)
        SELECT ?, user_id, ?, ?, 'rejected', ? FROM ${authority.table}
        WHERE ${authority.predicate}`)
          .bind(transactionId(), subject.id, operation, current, ...authority.bindings)
          .run()
      ).pipe(
        Effect.map((result) =>
          result.meta.changes === 1 ? ("recorded" as const) : ("credential_refused" as const)
        )
      );
    }),
    Effect.orElseSucceed(() => "unavailable" as const)
  );

/** A declared Budget refusal at the individual and atomic-batch seams. */
export const budgetRefusal = ({
  db,
  subject,
  operation,
  current,
  code,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: BudgetMutationOperation;
  current: number;
  code: "not_found" | "validation_failed";
}>): CanonicalMutationRefusal => ({
  code,
  message: code === "not_found" ? "Budget or Category unavailable." : "Budget input unavailable.",
  record: () => recordBudgetRefusal({ db, subject, operation, current }),
  respond: () =>
    Effect.succeed(
      transactionFailure({
        code,
        status: code === "not_found" ? HTTP_NOT_FOUND : HTTP_BAD_REQUEST,
        message:
          code === "not_found" ? "Budget or Category unavailable." : "Budget input unavailable.",
      })
    ),
});

/** An exhausted shared audit budget cannot write another refusal AuditLogEntry. */
export const budgetAuditLimitRefusal = (): CanonicalMutationRefusal => ({
  code: "rate_limited",
  message: "Daily audit budget exhausted.",
  record: () => Effect.succeed("rate_limited" as const),
  respond: () => Effect.succeed(transactionUnavailable()),
});

/** Read one Budget after its shared D1 unit committed; deletion returns only the removed id. */
export const findBudgetValue = ({
  db,
  userId,
  outcome,
}: Readonly<{
  db: D1Database;
  userId: string;
  outcome: BudgetOutcome;
}>): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  outcome.operation === "budgets.deleteBudget"
    ? Effect.succeedSome({ _tag: "RemovedBudget" as const, id: outcome.budgetId })
    : Effect.tryPromise(() => findOwnedBudget({ db, userId, id: outcome.budgetId })).pipe(
        Effect.map(Option.map((budget) => ({ _tag: "Budget" as const, budget }))),
        Effect.orElseSucceed(() => Option.none<CommittedMutationValue>())
      );

/** A Budget owner whose D1 authority cannot decide must fail closed. */
export const unavailableBudget = transactionUnavailable;
