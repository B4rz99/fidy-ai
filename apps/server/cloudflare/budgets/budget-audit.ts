import { recordCanonicalPATWork, recordLivePATUse } from "@fidy/server/tokens-runtime";
import { Effect } from "effect";
import { prepareOwnedStatement } from "../pats/pat-unit";
import type { BudgetOutcome } from "../mutations/mutation-types";
import {
  type TransactionCaller,
  callerAuthority,
  isPATCaller,
  liveTransactionAuthority,
  transactionId,
} from "../transactions/transaction-boundary";

type BudgetAuditOperation =
  | BudgetOutcome["operation"]
  | "budgets.listBudgets"
  | "budgets.getBudget"
  | "budgets.getBudgetStatus";

/** Attribute an accepted or rejected Budget call only under live User/PAT authority. */
export const recordBudgetCall = ({
  db,
  subject,
  operation,
  outcome,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: BudgetAuditOperation;
  outcome: "accepted" | "rejected";
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
                  outcome,
                  afterOwnerWrite: false,
                },
              }),
            }),
          ])
        ).pipe(
          Effect.map((rows) =>
            rows.every((row) => row.meta.changes === 1)
              ? ("recorded" as const)
              : ("credential_refused" as const)
          )
        );
      }
      const authority = callerAuthority({ subject, current });
      return Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO budget_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
          SELECT ?, user_id, ?, ?, ?, ? FROM ${authority.table} WHERE ${authority.predicate}`)
          .bind(transactionId(), subject.id, operation, outcome, current, ...authority.bindings)
          .run()
      ).pipe(
        Effect.map((row) =>
          row.meta.changes === 1 ? ("recorded" as const) : ("credential_refused" as const)
        )
      );
    }),
    Effect.orElseSucceed(() => "unavailable" as const)
  );
