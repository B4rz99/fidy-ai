import { readSqliteBudgetCaps } from "../budgets/operations";
import { DateTime, Effect, Option, Schema } from "effect";
import { DashboardDocument, type ProjectedRange } from "../../src/core/dashboard/contract";
import {
  collectLayoutWidgets,
  dashboardProjectionRanges,
} from "../../src/core/dashboard/operations";
import { UserContext, UserId } from "../../src/core/identity/contract";
import { Category } from "../../src/core/categories/contract";
import { DashboardView } from "../../src/shell/dashboard/contract";
import { renderDashboardView } from "../../src/shell/dashboard/operations";
import { readSqliteDashboardTransactions } from "../transactions/operations";

const Install = Schema.Struct({ statements: Schema.Array(Schema.String) });
const Read = Schema.Struct({
  userId: UserId,
  current: Schema.Int,
  accumulation: Schema.Literals(["compact", "bigint"]),
});
const DocumentRow = Schema.Struct({
  encoded: Schema.fromJsonString(Schema.toCodecJson(DashboardDocument)),
});
const monthCharacters = 7;
const encodeView = Schema.encodeSync(Schema.toCodecJson(DashboardView));

const readPeers = (
  sql: SqlStorage,
  userId: string
): Readonly<{
  context: UserContext;
  document: DashboardDocument;
  categories: ReadonlyArray<Category>;
}> => {
  const context = Schema.decodeUnknownSync(UserContext)(
    sql
      .exec(
        "SELECT service_market AS serviceMarket,locale,time_zone AS timeZone FROM users WHERE id=?",
        userId
      )
      .one()
  );
  const { encoded: document } = Schema.decodeUnknownSync(DocumentRow)(
    sql
      .exec(
        "SELECT document_json AS encoded FROM user_documents WHERE user_id=? AND kind='dashboard'",
        userId
      )
      .one()
  );
  const categories = Schema.decodeUnknownSync(Schema.Array(Category))(
    sql.exec("SELECT id,label FROM categories ORDER BY display_order,id").toArray()
  );
  return { context, document, categories };
};

const localMonth = (now: DateTime.Utc, context: UserContext): string =>
  DateTime.formatIsoDate(
    DateTime.setZone(now, DateTime.zoneMakeNamedUnsafe(context.timeZone))
  ).slice(0, monthCharacters);

const snapshot = (sql: SqlStorage, input: typeof Read.Type): Response => {
  const { context, document, categories } = readPeers(sql, input.userId);
  const now = DateTime.makeUnsafe(input.current);
  const widgets = collectLayoutWidgets(document.layout);
  const plans = widgets
    .filter((widget) => widget.type !== "transaction-list")
    .map((widget) => ({
      id: widget.id,
      ranges: dashboardProjectionRanges(widget, now, context.timeZone),
    }));
  const ranges = plans.flatMap((plan) => plan.ranges);
  const lists = widgets.filter((widget) => widget.type === "transaction-list");
  const facts = Effect.runSync(
    readSqliteDashboardTransactions({
      sql,
      userId: input.userId,
      categories,
      ranges,
      lists: lists.map((widget) => ({
        categories: widget.categories ?? [],
        search: Option.fromUndefinedOr(widget.search),
        limit: widget.limit,
      })),
      accumulation: input.accumulation,
    })
  );
  const groups = new Map<string, ReadonlyArray<ProjectedRange>>();
  let position = 0;
  for (const plan of plans) {
    groups.set(
      plan.id,
      plan.ranges.map((range) => ({
        key: range.key,
        contributions: facts.ranges[position++] ?? [],
      }))
    );
  }
  const month = localMonth(now, context);
  const budgets = Option.getOrThrow(
    Effect.runSync(readSqliteBudgetCaps({ sql, userId: input.userId, month }))
  );
  const view = Effect.runSync(
    renderDashboardView({
      document,
      now,
      facts: {
        context,
        categories: new Map(categories.map((category) => [category.id, category])),
        groups,
        budgets,
        lists: new Map(lists.map((widget, index) => [widget.id, facts.lists[index] ?? []])),
      },
    })
  );
  return Response.json(
    { data: encodeView(view), measurement: facts.measurement },
    { headers: { "cache-control": "no-store" } }
  );
};

/** Synthetic isolated engine qualification only; no production data, ingress, or binding. */
export class DashboardEngineProof {
  private readonly state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }
  fetch(request: Request): Promise<Response> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        if (new URL(request.url).pathname === "/receipts") {
          return Response.json(
            this.state.storage.sql.exec("SELECT count(*) AS count FROM engine_read_receipts").one()
          );
        }
        const raw = yield* Effect.tryPromise(() => request.json());
        if (new URL(request.url).pathname === "/install") {
          const input = yield* Schema.decodeUnknownEffect(Install)(raw);
          this.state.storage.transactionSync(() => {
            for (const statement of input.statements) this.state.storage.sql.exec(statement);
            this.state.storage.sql.exec(
              "CREATE TABLE IF NOT EXISTS engine_read_receipts(id INTEGER PRIMARY KEY)"
            );
          });
          return new Response(null, { status: 204 });
        }
        const input = yield* Schema.decodeUnknownEffect(Read)(raw);
        return yield* Effect.try(() =>
          this.state.storage.transactionSync(() => {
            this.state.storage.sql.exec("INSERT INTO engine_read_receipts DEFAULT VALUES");
            return snapshot(this.state.storage.sql, input);
          })
        );
      }).pipe(Effect.orElseSucceed(() => new Response(null, { status: 503 })))
    );
  }
}
export default {
  fetch: (request: Request, env: Readonly<{ PROOF: DurableObjectNamespace }>): Promise<Response> =>
    env.PROOF.getByName("synthetic").fetch(request),
};
