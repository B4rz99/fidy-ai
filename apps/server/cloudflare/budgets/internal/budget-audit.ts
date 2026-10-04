import type { BudgetOutcome } from "../contract";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import { Effect } from "effect";
import { prepareOwnedStatement } from "../../database/operations";
import {
  type QueryCaller,
  callerAuthority,
  isPATCaller,
  liveTransactionAuthority,
  transactionId,
} from "../../canonical-work/operations";

type BudgetAuditOperation =
  | BudgetOutcome["operation"]
  | "budgets.listBudgets"
  | "budgets.getBudget"
  | "budgets.getBudgetStatus";

type BudgetAuditCall = Readonly<{
  db: D1Database;
  subject: QueryCaller;
  operation: BudgetAuditOperation;
  outcome: "accepted" | "rejected";
  current: number;
}>;

/** Attribute an accepted or rejected Budget call only under live User/PAT authority. */
export const recordBudgetCall = ({
  db,
  subject,
  operation,
  outcome,
  current,
}: BudgetAuditCall): Effect.Effect<"recorded" | "credential_refused" | "unavailable"> =>
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
                authority: livePATAuthority({ subject, current }),
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
        prepareAuthorizedAuditCall({
          db,
          authority,
          id: transactionId(),
          operation,
          outcome,
          current,
          afterOwnerWrite: false,
        }).run()
      ).pipe(
        Effect.map((row) =>
          row.meta.changes === 1 ? ("recorded" as const) : ("credential_refused" as const)
        )
      );
    }),
    Effect.orElseSucceed(() => "unavailable" as const)
  );
