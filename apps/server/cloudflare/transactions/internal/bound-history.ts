import { Effect, Option } from "effect";
import type { CanonicalBrowserRead } from "../../canonical-admission/contract";
import { transactionUnavailable } from "../../canonical-work/operations";
import { newId } from "../../secret-material/operations";
import { recordAuthorizedCall } from "../../../src/shell/audit/operations";
import { prepareReservedChangeAssertion } from "../../../src/shell/sql-assertions/operations";
import { invalid, parseQuery, presentHistory, selectedListStatement } from "./transaction-history";

/** Browser History stays bounded and decoded; pressure, exact live ownership, Audit and standing
 * compose around this prepared read in the same native transaction. No work follows presentation.
 */
export const prepareBoundTransactionRead = (request: Request): CanonicalBrowserRead => {
  const selection = { request, id: Option.none<string>(), search: false } as const;
  const query = parseQuery(selection);
  return ({ db, authority, reservation, current }) => {
    const audit = recordAuthorizedCall({
      authority,
      id: newId(),
      current,
      operation: "transactions.listTransactions",
      outcome: Option.isSome(query) ? "success" : "validation_failed",
      afterOwnerWrite: false,
    });
    return {
      statements: [
        ...Option.toArray(
          Option.map(query, (decoded) =>
            selectedListStatement({
              db,
              authority,
              userSelection: reservation,
              query: decoded,
            })
          )
        ),
        db.prepare(audit.sql).bind(...audit.params),
        prepareReservedChangeAssertion({ db, scope: "transaction_fact", reservation }),
      ],
      present: (results) =>
        Effect.try(() => {
          const auditIndex = Option.isSome(query) ? 1 : 0;
          if (results[auditIndex]?.meta.changes !== 1) return transactionUnavailable();
          if (Option.isNone(query)) return invalid();
          const rows = results[0];
          return rows === undefined
            ? transactionUnavailable()
            : presentHistory({ rows, selection, query: query.value });
        }).pipe(Effect.orElseSucceed(transactionUnavailable)),
    };
  };
};
