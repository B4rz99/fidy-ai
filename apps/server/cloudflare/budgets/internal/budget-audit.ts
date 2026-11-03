import type { BudgetOutcome } from "../contract";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import { Effect } from "effect";
import {
  type QueryCaller,
  callerAuthority,
  isPATCaller,
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

/** Account for a Budget call through the write's live caller-authority predicate. */
export const recordBudgetCall = ({
  db,
  subject,
  operation,
  outcome,
  current,
}: BudgetAuditCall): Effect.Effect<"recorded" | "credential_refused" | "unavailable"> =>
  Effect.gen(function* () {
    if (isPATCaller(subject)) {
      const rows = yield* Effect.tryPromise(() =>
        db.batch(
          [
            recordLivePATUse({ subject, current }),
            recordCanonicalPATWork({
              authority: livePATAuthority({ subject, current }),
              input: {
                id: transactionId(),
                current,
                operation,
                outcome,
                afterOwnerWrite: false,
              },
            }),
          ].map(({ sql, params }) => db.prepare(sql).bind(...params))
        )
      );
      return rows.every((row) => row.meta.changes === 1)
        ? ("recorded" as const)
        : ("credential_refused" as const);
    }
    const authority = callerAuthority({ subject, current });
    const row = yield* Effect.tryPromise(() =>
      prepareAuthorizedAuditCall({
        db,
        authority,
        id: transactionId(),
        operation,
        outcome,
        current,
        afterOwnerWrite: false,
      }).run()
    );
    return row.meta.changes === 1 ? ("recorded" as const) : ("credential_refused" as const);
  }).pipe(Effect.orElseSucceed(() => "unavailable" as const));
