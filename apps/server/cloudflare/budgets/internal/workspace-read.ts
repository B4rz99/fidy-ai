import { DateTime, Effect, Option, Schema } from "effect";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import type {
  BudgetStatusQueryParameters,
  BudgetWorkspace,
} from "../../../src/core/budgets/contract";
import {
  prepareBoundTransactionAggregate,
  prepareTransactionAggregate,
} from "../../transactions/operations";
import { budgetPeriod } from "./budget-queries";
import { assembleBudgetReport } from "./budget-report";
import { decodePlannedCaps, preparePlannedCaps } from "./planned-caps";

type Workspace = typeof BudgetWorkspace.Type;
type WorkspaceRead = Readonly<{
  db: D1Database;
  query: typeof BudgetStatusQueryParameters.Type;
  now: DateTime.Utc;
}> &
  (Readonly<{ userId: string }> | Readonly<{ userSelection: OwnedStatement }>);
const monthLabelLength = 7;
const activeFlags = Schema.Array(Schema.Struct({ active_in_month: Schema.Literals([0, 1]) }));
const planState = Schema.Tuple([Schema.Struct({ initialized: Schema.Literals([0, 1]) })]);

type PreparedWorkspace = Readonly<{
  statements: Array<D1PreparedStatement>;
  decode: (rows: ReadonlyArray<D1Result>) => Effect.Effect<Option.Option<Workspace>>;
}>;

/** Prepare complete editing metadata and exact spending for the caller's same native snapshot. */
export const prepareBudgetWorkspace = (input: WorkspaceRead): Option.Option<PreparedWorkspace> => {
  const { db, query, now } = input;
  const period = budgetPeriod({ now, query });
  const month = DateTime.formatIsoDate(
    DateTime.setZone(period.from, DateTime.zoneMakeNamedUnsafe(query.timeZone))
  ).slice(0, monthLabelLength);
  const range = {
    db,
    from: DateTime.toEpochMillis(period.from),
    toExclusive: DateTime.toEpochMillis(period.to),
  };
  const selection =
    "userId" in input ? { sql: "SELECT ? AS userId", params: [input.userId] } : input.userSelection;
  const aggregate =
    "userId" in input
      ? prepareTransactionAggregate({ ...range, userId: input.userId })
      : prepareBoundTransactionAggregate({ ...range, userSelection: input.userSelection });
  return Option.map(aggregate, (prepared) => ({
    statements: [
      preparePlannedCaps({ db, userSelection: selection, month, includeInactive: true }),
      db
        .prepare(`SELECT EXISTS(SELECT 1 FROM budget_month_plan_records WHERE kind='plan'
        AND user_id = (SELECT userId FROM (${selection.sql})) AND month=?) AS initialized`)
        .bind(...selection.params, month),
      ...prepared.statements,
    ],
    decode: (rows: ReadonlyArray<D1Result>): Effect.Effect<Option.Option<Workspace>> =>
      Effect.gen(function* () {
        const caps = rows[0]?.results;
        const budgets = yield* decodePlannedCaps(caps ?? []);
        const flags = Schema.decodeUnknownOption(activeFlags)(caps);
        const initialized = Schema.decodeUnknownOption(planState)(rows[1]?.results);
        const values = prepared.decode(rows.slice(2));
        const snapshot = Option.all({ budgets, flags, initialized, values });
        if (Option.isNone(snapshot)) return Option.none<Workspace>();
        const data = snapshot.value;
        const report = yield* assembleBudgetReport({
          budgets: data.budgets.filter((_, index) => data.flags[index]?.active_in_month === 1),
          aggregates: data.values,
          period,
          query,
          initialized: data.initialized[0].initialized === 1,
        });
        return Option.some({ ...report, budgets: data.budgets });
      }).pipe(Effect.orElseSucceed(() => Option.none())),
  }));
};

/** Read complete editing metadata and active spending from one native, same-User snapshot. */
export const readBudgetWorkspace = (
  input: WorkspaceRead
): Effect.Effect<Option.Option<Workspace>> =>
  Effect.gen(function* () {
    const prepared = prepareBudgetWorkspace(input);
    if (Option.isNone(prepared)) return Option.none<Workspace>();
    const rows = yield* Effect.tryPromise(() => input.db.batch(prepared.value.statements));
    return yield* prepared.value.decode(rows);
  }).pipe(Effect.orElseSucceed(() => Option.none()));
