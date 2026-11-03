import { DateTime, Effect, Option } from "effect";
import type { CanonicalBrowserRead } from "../../canonical-admission/contract";
import { prepareAuthorizedAuditCall } from "../../../src/shell/audit/operations";
import { prepareReservedChangeCheck } from "../../../src/shell/sql-assertions/operations";
import { encodeBudgetWorkspace as encodeWorkspace } from "./workspace-encoding";
import {
  transactionFailure,
  transactionId,
  transactionNoStore,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { budgetParameters } from "./budget-queries";
import { prepareBudgetWorkspace } from "./workspace-read";

/** Resolve live caller, planned caps and exact spending inside admission's atomic browser read. */
export const prepareBoundBudgetWorkspace = (request: Request): CanonicalBrowserRead => {
  const parsed = budgetParameters({
    operation: "budgets.getBudgetStatus",
    url: new URL(request.url),
  });
  return ({ db, authority, reservation, current }) => {
    const prepared = Option.flatMap(parsed, ({ query }) =>
      Option.flatMap(query, (parameters) =>
        prepareBudgetWorkspace({
          db,
          userSelection: reservation,
          query: parameters,
          now: DateTime.makeUnsafe(current),
        })
      )
    );
    const statements = Option.isSome(prepared) ? prepared.value.statements : [];
    return {
      statements: [
        ...statements,
        prepareAuthorizedAuditCall({
          db,
          authority,
          id: transactionId(),
          current,
          operation: "budgets.getBudgetStatus",
          outcome: Option.isSome(parsed) ? "accepted" : "rejected",
          afterOwnerWrite: false,
        }),
        prepareReservedChangeCheck({ db, scope: "budget_mutation", reservation }),
      ],
      present: (results) =>
        Effect.gen(function* () {
          if (results[statements.length]?.meta.changes !== 1) return transactionUnavailable();
          if (Option.isNone(parsed)) {
            return transactionFailure({
              code: "validation_failed",
              status: 400,
              message: "Invalid Budget query.",
            });
          }
          if (Option.isNone(prepared)) return transactionUnavailable();
          const workspace = yield* prepared.value.decode(results.slice(0, statements.length));
          if (Option.isNone(workspace)) return transactionUnavailable();
          const data = yield* encodeWorkspace(workspace.value);
          return Response.json({ data, next: [] }, { headers: transactionNoStore });
        }).pipe(Effect.orElseSucceed(transactionUnavailable)),
    };
  };
};
