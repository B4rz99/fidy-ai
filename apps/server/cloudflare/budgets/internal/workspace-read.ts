import { DateTime, Effect, Option, Schema } from "effect";
import type {
  BudgetStatusQueryParameters,
  BudgetWorkspace,
} from "../../../src/core/budgets/contract";
import { prepareTransactionAggregate } from "../../transactions/operations";
import { budgetPeriod } from "./budget-queries";
import { assembleBudgetReport } from "./budget-report";
import { decodePlannedCaps, preparePlannedCaps } from "./planned-caps";

type Workspace = typeof BudgetWorkspace.Type;
const monthLabelLength = 7;

const activeFlags = Schema.Array(Schema.Struct({ active_in_month: Schema.Literals([0, 1]) }));
const planState = Schema.Tuple([Schema.Struct({ initialized: Schema.Literals([0, 1]) })]);

/** Read complete editing metadata and active spending from one native, same-User snapshot. */
export const readBudgetWorkspace = ({
  db,
  userId,
  query,
  now,
}: Readonly<{
  db: D1Database;
  userId: string;
  query: typeof BudgetStatusQueryParameters.Type;
  now: DateTime.Utc;
}>): Effect.Effect<Option.Option<Workspace>> =>
  Effect.gen(function* () {
    const period = budgetPeriod({ now, query });
    const month = DateTime.formatIsoDate(
      DateTime.setZone(period.from, DateTime.zoneMakeNamedUnsafe(query.timeZone))
    ).slice(0, monthLabelLength);
    const aggregate = prepareTransactionAggregate({
      db,
      userId,
      from: DateTime.toEpochMillis(period.from),
      toExclusive: DateTime.toEpochMillis(period.to),
    });
    if (Option.isNone(aggregate)) return Option.none<Workspace>();
    const rows = yield* Effect.tryPromise(() =>
      db.batch([
        preparePlannedCaps({ db, userId, month, includeInactive: true }),
        db
          .prepare(
            "SELECT EXISTS(SELECT 1 FROM budget_month_plan_records WHERE kind='plan' AND user_id=? AND month=?) AS initialized"
          )
          .bind(userId, month),
        ...aggregate.value.statements,
      ])
    );
    const caps = rows[0]?.results;
    const budgets = yield* decodePlannedCaps(caps ?? []);
    const flags = Schema.decodeUnknownOption(activeFlags)(caps);
    const initialized = Schema.decodeUnknownOption(planState)(rows[1]?.results);
    const values = aggregate.value.decode(rows.slice(2));
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
  }).pipe(Effect.orElseSucceed(() => Option.none()));
