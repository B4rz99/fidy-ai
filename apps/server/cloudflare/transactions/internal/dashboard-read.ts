import { Effect, Option, Schema } from "effect";
import type {
  DashboardTransactionFact,
  DashboardTransactionRead,
  DashboardTransactionSnapshot,
} from "../contract";
import { CategoryId } from "../../../src/core/categories/reference";
import { dashboardTransactionQueries, decodeDashboardTransactions } from "./dashboard-query";
import { projectionReady } from "./dashboard-projection";

const maximumFilteredCategories = 16;
const maximumDashboardLists = 24;
const DashboardList = Schema.Struct({
  categories: Schema.Array(CategoryId).check(
    Schema.isMaxLength(maximumFilteredCategories),
    Schema.isUnique()
  ),
  search: Schema.Option(Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(100))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
});
const DashboardLists = Schema.Array(DashboardList).check(Schema.isMaxLength(maximumDashboardLists));

/**
 * Read complete, decoded list pages only when this User's projection is ready. The supplied
 * caller read, readiness and every list share one atomic snapshot. A missing, oversized or
 * malformed page makes the entire read unavailable rather than returning partial financial facts.
 */
export const readDashboardTransactions = <A>({
  db,
  userId,
  lists,
  categories,
  snapshot,
}: DashboardTransactionRead<A>): Effect.Effect<Option.Option<DashboardTransactionSnapshot<A>>> =>
  Effect.gen(function* () {
    if (Option.isNone(Schema.decodeOption(DashboardLists)(lists))) return Option.none();
    const [context, state, ...pages] = yield* Effect.tryPromise(() =>
      db.batch([
        snapshot.statement,
        db
          .prepare("SELECT version, readiness FROM dashboard_projection_state WHERE user_id = ?")
          .bind(userId),
        ...dashboardTransactionQueries({ db, userId, lists }),
      ])
    );
    if (
      context === undefined ||
      state?.results.length !== 1 ||
      !projectionReady(state.results[0]) ||
      pages.length !== lists.length
    ) {
      return Option.none();
    }
    const observed = snapshot.decode(context.results);
    if (Option.isNone(observed)) return Option.none();
    const decoded = Option.all(
      lists.map((list, index) => {
        const page = pages[index];
        return page === undefined || page.results.length > list.limit
          ? Option.none<ReadonlyArray<DashboardTransactionFact>>()
          : decodeDashboardTransactions({ rows: page.results, categories });
      })
    );
    return Option.map(decoded, (selected) => ({ snapshot: observed.value, lists: selected }));
  }).pipe(Effect.orElseSucceed(() => Option.none()));
