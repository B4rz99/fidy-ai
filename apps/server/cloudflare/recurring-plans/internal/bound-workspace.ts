import { DateTime, Effect, Option, Schema } from "effect";
import type {
  CanonicalBrowserRead,
  PreparedCanonicalBrowserRead,
} from "../../canonical-admission/contract";
import { UserPreferences } from "../../../src/core/identity/contract";
import { prepareUserContext } from "../../identity/user-context/operations";
import { prepareBoundPlanningTransactions } from "../../transactions/operations";
import { prepareAuthorizedAuditCall } from "../../../src/shell/audit/operations";
import { prepareReservedChangeCheck } from "../../../src/shell/sql-assertions/operations";
import {
  RecurringWorkspace,
  RecurringWorkspaceQuery,
} from "../../../src/shell/recurring-plans/contract";
import {
  transactionFailure,
  transactionId,
  transactionNoStore,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { planningReferences, planningUsers } from "./store";
import { matchingRange, previousMonth, workspaceFromReadProjection } from "./query";
import { prepareReadProjection } from "./read-projection";
import { linkedTransactionIds } from "./facts";

const invalid = (): Response =>
  transactionFailure({
    code: "validation_failed",
    status: 400,
    message: "Selecciona un mes válido.",
  });

const prepareWorkspace = ({
  db,
  reservation,
  current,
  query,
}: Parameters<CanonicalBrowserRead>[0] &
  Readonly<{
    query: typeof RecurringWorkspaceQuery.Type;
  }>): Option.Option<PreparedCanonicalBrowserRead> => {
  const document = prepareReadProjection({ db, users: reservation, query });
  const context = prepareUserContext({
    db,
    userSelection: reservation,
    statement: { sql: "SELECT locale,timeZone FROM identity_user_context", params: [] },
  });
  return Option.map(
    prepareBoundPlanningTransactions({
      db,
      userSelection: planningUsers(reservation),
      references: planningReferences(reservation),
      ranges: [
        matchingRange(query.previousMonth ?? previousMonth(query.month)),
        matchingRange(query.month),
      ],
    }),
    (facts) => ({
      statements: [...document.statements, context, ...facts.statements],
      present: (rows) =>
        Effect.gen(function* () {
          const source = yield* document.decode(rows.slice(0, document.statements.length));
          const preferences = Schema.decodeUnknownOption(Schema.Tuple([UserPreferences]))(
            rows[document.statements.length]?.results ?? []
          );
          const selected = facts.decode(
            rows.slice(
              document.statements.length + 1,
              document.statements.length + 1 + facts.statements.length
            ),
            linkedTransactionIds(source.schedule)
          );
          if (Option.isNone(preferences) || Option.isNone(selected)) {
            return transactionUnavailable();
          }
          const view = yield* workspaceFromReadProjection({
            projection: source,
            query,
            now: DateTime.makeUnsafe(current),
            observed: { ...selected.value, snapshot: preferences.value[0] },
          });
          const data = yield* Schema.encodeEffect(Schema.toCodecJson(RecurringWorkspace))(view);
          return Response.json({ data, next: [] }, { headers: transactionNoStore });
        }).pipe(Effect.orElseSucceed(transactionUnavailable)),
    })
  );
};

export const prepareBoundWorkspace = (request: Request): CanonicalBrowserRead => {
  const query = Schema.decodeUnknownOption(RecurringWorkspaceQuery)(
    Object.fromEntries(new URL(request.url).searchParams)
  ).pipe(
    Option.filter((query) => query.previousMonth === undefined || query.previousMonth < query.month)
  );
  return (input) => {
    const prepared = Option.flatMap(query, (query) => prepareWorkspace({ ...input, query }));
    return {
      statements: [
        ...Option.toArray(Option.map(prepared, (value) => value.statements)).flat(),
        prepareAuthorizedAuditCall({
          db: input.db,
          authority: input.authority,
          id: transactionId(),
          current: input.current,
          operation: "recurringPlans.getRecurringWorkspace",
          outcome: Option.isSome(prepared) ? "accepted" : "rejected",
          afterOwnerWrite: false,
        }),
        prepareReservedChangeCheck({
          db: input.db,
          scope: "recurring_plan",
          reservation: input.reservation,
        }),
      ],
      present: (rows) =>
        Option.match(prepared, {
          onNone: () => Effect.succeed(invalid()),
          onSome: (value) => value.present(rows),
        }),
    };
  };
};
