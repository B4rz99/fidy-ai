import { expect, layer } from "@effect/vitest";
import { Array, BigDecimal, DateTime, Effect, Layer, Option, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { SqlSchema } from "effect/unstable/sql";
import { MigrationSqlClient, PgLive } from "~/shell/db/client";
import { CategoryId } from "~/core/categories/reference";
import { IanaTimeZone } from "~/core/_shared/context";
import { categoryIds } from "~/core/categories/taxonomy";
import { SplitWeight, TransactionListLimit, WidgetId } from "~/core/dashboard/model";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import { freePatCaller } from "~/shell/_shared/suggested-operations";
import { defaultUserId } from "~/shell/db/development-seed";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { defaultPatBearer } from "~/shell/testing/identity-fixtures";
import {
  dashboardListStatement,
  dashboardMetricStatement,
  selectDashboardTransactionSumsInScope,
} from "~/shell/transactions/repo";
import { ApiHarness, ApiHarnessClient, headersFor } from "~/shell/testing/api-harness";
import { truncateDashboards } from "./fixtures";
import { applyDashboardEdit } from "./mutations";
import type { DashboardView } from "./operations";
import { getDashboardView } from "./view";

type DashboardWidgetView = Extract<DashboardView["layout"], { readonly kind: "leaf" }>["widget"];
const collectWidgetViews = (layout: DashboardView["layout"]): ReadonlyArray<DashboardWidgetView> =>
  layout.kind === "leaf"
    ? [layout.widget]
    : layout.children.flatMap(({ node }) => collectWidgetViews(node));

const assertChartResult = (candidate: Option.Option<DashboardWidgetView>): void => {
  const view = Option.getOrThrow(candidate);
  if (!("buckets" in view.result)) throw new Error("Expected chart result");
  expect(view.result.buckets).toHaveLength(1);
  const bucket = Array.get(view.result.buckets, 0).pipe(Option.getOrThrow);
  const cop = bucket.moneyGroups.find(({ currency }) => currency === "COP");
  const usd = bucket.moneyGroups.find(({ currency }) => currency === "USD");
  expect(BigDecimal.format(Option.getOrThrow(Option.fromUndefinedOr(cop)).inflow.amount)).toBe(
    "25"
  );
  expect(BigDecimal.format(Option.getOrThrow(Option.fromUndefinedOr(usd)).outflow.amount)).toBe(
    "9007199254740993.12"
  );
};
const assertBudgetResult = (candidate: Option.Option<DashboardWidgetView>): void => {
  const view = Option.getOrThrow(candidate);
  if (!("availability" in view.result)) throw new Error("Expected Budget result");
  expect(view.result.availability).toBe("missing-budget");
};
const assertListResult = (candidate: Option.Option<DashboardWidgetView>): void => {
  const view = Option.getOrThrow(candidate);
  if (!("transactions" in view.result)) throw new Error("Expected list result");
  expect(view.result.transactions).toHaveLength(1);
  expect(Array.get(view.result.transactions, 0).pipe(Option.getOrThrow)).not.toHaveProperty(
    "notes"
  );
  expect(Array.get(view.result.transactions, 0).pipe(Option.getOrThrow).category.label).toBe(
    "Restaurantes"
  );
};
const assertMetricResult = (candidate: Option.Option<DashboardWidgetView>): void => {
  const view = Option.getOrThrow(candidate);
  if (!("moneyGroups" in view.result)) throw new Error("Expected metric result");
  expect(view.result.moneyGroups.map(({ currency }) => currency)).toEqual(["COP", "USD"]);
};

const ExplainRow = Schema.Struct({ "QUERY PLAN": Schema.String });
const testDashboardTimeZone = Schema.decodeUnknownSync(IanaTimeZone)("America/Bogota");
const explainDashboardTransactionAccess = Effect.gen(function* () {
  const admin = yield* MigrationSqlClient;
  return yield* admin.withTransaction(
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* sql`SET LOCAL enable_seqscan = off`;
      yield* sql`SET LOCAL enable_sort = off`;
      yield* sql`SET LOCAL enable_incremental_sort = off`;
      const recentStatement = dashboardListStatement({
        sql,
        userId: defaultUserId,
        query: { categories: [], search: Option.none(), searchCategoryIds: [], limit: 12 },
      });
      const recent = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: ExplainRow,
        execute: () => sql`EXPLAIN ${recentStatement}`,
      })(undefined).pipe(Effect.orDie);
      const aggregateStatement = dashboardMetricStatement({
        sql,
        userId: defaultUserId,
        query: {
          aggregation: "sum",
          categories: [],
          from: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
          toExclusive: DateTime.makeUnsafe("2026-02-01T00:00:00Z"),
        },
      });
      const aggregate = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: ExplainRow,
        execute: () => sql`EXPLAIN ${aggregateStatement}`,
      })(undefined).pipe(Effect.orDie);
      const period = {
        from: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
        toExclusive: DateTime.makeUnsafe("2026-02-01T00:00:00Z"),
      };
      yield* sql`EXPLAIN ${dashboardMetricStatement({
        sql,
        userId: defaultUserId,
        query: { ...period, aggregation: "average", categories: [categoryIds.restaurantes] },
      })}`;
      yield* sql`EXPLAIN ${dashboardMetricStatement({
        sql,
        userId: defaultUserId,
        query: { ...period, aggregation: "maximum", categories: [] },
      })}`;
      yield* sql`EXPLAIN ${dashboardListStatement({
        sql,
        userId: defaultUserId,
        query: {
          categories: [categoryIds.restaurantes],
          search: Option.some("restaurante"),
          searchCategoryIds: [],
          limit: 12,
        },
      })}`;
      yield* sql`EXPLAIN ${dashboardListStatement({
        sql,
        userId: defaultUserId,
        query: {
          categories: [],
          search: Option.some("restaurante"),
          searchCategoryIds: [categoryIds.restaurantes],
          limit: 12,
        },
      })}`;
      return { recent, aggregate };
    })
  );
});

const transactionList = (
  id: string
): { id: WidgetId; type: "transaction-list"; limit: TransactionListLimit } => ({
  id: WidgetId.make(id),
  type: "transaction-list" as const,
  limit: TransactionListLimit.make(10),
});

const expectNotFoundMessage = <A, E>(outcome: Result.Result<A, E>, expected: string): void => {
  expect(Result.isFailure(outcome)).toBe(true);
  if (!Result.isFailure(outcome)) return;
  expect(Schema.is(NotFound)(outcome.failure)).toBe(true);
  if (!Schema.is(NotFound)(outcome.failure)) return;
  expect(outcome.failure.error.message).toContain(expected);
};

const expectValidationFieldPath = <A, E>(outcome: Result.Result<A, E>, expected: string): void => {
  expect(Result.isFailure(outcome)).toBe(true);
  if (!Result.isFailure(outcome) || !Schema.is(ValidationFailed)(outcome.failure)) return;
  expect(outcome.failure.error.fields[0]?.path).toBe(expected);
};

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "dashboard operations",
  (it) => {
    it.effect("retains one valid non-empty default DashboardDocument for the caller", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const client = yield* ApiHarnessClient;

        const first = yield* client.dashboard.getDashboard();
        const second = yield* client.dashboard.getDashboard();

        expect(first.data.title).toBe("Tablero");
        expect(first.data.layout.kind).toBe("leaf");
        expect(second.data).toEqual(first.data);
      })
    );

    it.effect("returns one current-context real-data result for every decoded Widget", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const client = yield* ApiHarnessClient;

        const response = yield* client.dashboard.getDashboardView();

        expect(response.data.context).toMatchObject({
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: "America/Bogota",
        });
        expect(response.data.context.calculatedAt).toBeDefined();
        expect(response.data.title).toBe("Tablero");
        expect(response.data.layout.kind).toBe("leaf");
        if (response.data.layout.kind === "leaf") {
          expect(response.data.layout.widget).toMatchObject({
            widget: { type: "spending-chart" },
            result: {
              appliedPeriod: { requested: "this-month", timeZone: "America/Bogota" },
            },
          });
        }
      })
    );

    it.effect("returns real purpose-specific results for all four closed Widget variants", () => {
      const marker = "dashboard-private-search-marker";
      const cleanupMarker = "dashboard-cross-category-marker";
      return Effect.gen(function* () {
        yield* truncateDashboards;
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM transactions WHERE notes = ${marker} OR notes = ${cleanupMarker}`;
        yield* sql`
          INSERT INTO transactions
            (user_id, amount, currency, counterparty, direction, category_id, notes, occurred_at)
          VALUES
            (${defaultUserId}, 9007199254740993.12, 'USD', NULL, 'outflow',
              ${categoryIds.restaurantes}, ${marker}, now()),
            (${defaultUserId}, 25, 'COP', 'Ingreso de prueba', 'inflow',
              ${categoryIds.transporte}, ${cleanupMarker}, now())
        `;
        const client = yield* ApiHarnessClient;
        const initial = yield* client.dashboard.getDashboard();
        if (initial.data.layout.kind !== "leaf") return yield* Effect.die("Expected default leaf");
        const chartId = initial.data.layout.widget.id;
        yield* client.dashboard.applyDashboardEdit({
          payload: {
            op: "update-widget",
            widget: {
              id: chartId,
              type: "spending-chart",
              groupBy: "day",
              period: "last-7-days",
            },
          },
        });
        yield* client.dashboard.applyDashboardEdit({
          payload: {
            op: "add-widget",
            at: "bottom",
            widget: {
              id: WidgetId.make("f1d1a000-0000-4000-8000-000000000711"),
              type: "budget-bar",
              categoryId: categoryIds.restaurantes,
              currency: "USD",
            },
          },
        });
        yield* client.dashboard.applyDashboardEdit({
          payload: {
            op: "add-widget",
            at: "bottom",
            widget: {
              id: WidgetId.make("f1d1a000-0000-4000-8000-000000000712"),
              type: "transaction-list",
              limit: TransactionListLimit.make(5),
              search: marker,
            },
          },
        });
        yield* client.dashboard.applyDashboardEdit({
          payload: {
            op: "add-widget",
            at: "bottom",
            widget: {
              id: WidgetId.make("f1d1a000-0000-4000-8000-000000000713"),
              type: "custom-metric",
              label: "Transacciones recientes",
              aggregation: "sum",
              period: "last-7-days",
            },
          },
        });

        const response = yield* client.dashboard.getDashboardView();
        const widgets = collectWidgetViews(response.data.layout);

        expect(widgets.map(({ widget }) => widget.type)).toEqual([
          "spending-chart",
          "budget-bar",
          "transaction-list",
          "custom-metric",
        ]);
        assertChartResult(Array.get(widgets, 0));
        assertBudgetResult(Array.get(widgets, 1));
        assertListResult(Array.get(widgets, 2));
        assertMetricResult(Array.get(widgets, 3));
      }).pipe(
        Effect.ensuring(
          Effect.flatMap(MigrationSqlClient, (sql) =>
            sql`DELETE FROM transactions WHERE notes = ${marker} OR notes = ${cleanupMarker}`.pipe(
              Effect.orDie
            )
          )
        )
      );
    });

    it.effect("preserves nested axes, weights, child order, and leaf identity in projection", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const client = yield* ApiHarnessClient;
        const initial = yield* client.dashboard.getDashboard();
        if (initial.data.layout.kind !== "leaf") return yield* Effect.die("Expected default leaf");
        const firstId = initial.data.layout.widget.id;
        const secondId = WidgetId.make("f1d1a000-0000-4000-8000-000000000721");
        const thirdId = WidgetId.make("f1d1a000-0000-4000-8000-000000000722");
        yield* client.dashboard.applyDashboardEdit({
          payload: {
            op: "add-widget",
            widget: transactionList(secondId),
            at: { besideWidget: firstId, axis: "row", side: "after" },
          },
        });
        yield* client.dashboard.applyDashboardEdit({
          payload: {
            op: "add-widget",
            widget: transactionList(thirdId),
            at: { besideWidget: secondId, axis: "column", side: "after" },
          },
        });
        yield* client.dashboard.applyDashboardEdit({
          payload: { op: "resize-widget", widgetId: thirdId, weight: SplitWeight.make(3) },
        });

        const response = yield* client.dashboard.getDashboardView();
        const root = response.data.layout;
        expect(root.kind).toBe("split");
        if (root.kind !== "split") return;
        expect(root.axis).toBe("row");
        expect(root.children.map(({ weight }) => weight)).toEqual([1, 1]);
        expect(root.children[0].node.kind).toBe("leaf");
        const nested = root.children[1].node;
        expect(nested.kind).toBe("split");
        if (nested.kind !== "split") return;
        expect(nested.axis).toBe("column");
        expect(nested.children.map(({ weight }) => weight)).toEqual([1, 3]);
        expect(collectWidgetViews(root).map(({ widget }) => widget.id)).toEqual([
          firstId,
          secondId,
          thirdId,
        ]);
      })
    );

    it.effect("projects every requested Dashboard Transaction grouping key", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        const marker = "dashboard-grouping-coverage";
        yield* sql`
          INSERT INTO transactions
            (user_id, amount, currency, direction, category_id, notes, occurred_at)
          VALUES
            (${defaultUserId}, 25, 'COP', 'outflow', ${categoryIds.restaurantes},
              ${marker}, '2026-07-20T12:00:00Z')
        `;
        const period = {
          from: DateTime.makeUnsafe("2000-01-01T00:00:00Z"),
          toExclusive: DateTime.makeUnsafe("2100-01-01T00:00:00Z"),
        };
        const groups = yield* withUserTransaction(
          defaultUserId,
          Effect.forEach(["category", "day", "month"] as const, (groupBy) =>
            selectDashboardTransactionSumsInScope(defaultUserId, {
              ...period,
              categories: [],
              groupBy,
              timeZone: testDashboardTimeZone,
            })
          )
        );
        expect(groups.map((facts) => Array.get(facts, 0).pipe(Option.getOrThrow).key.kind)).toEqual(
          ["category", "day", "month"]
        );
        yield* sql`DELETE FROM transactions WHERE notes = ${marker}`;
      })
    );

    it.effect("uses selective Dashboard Transaction indexes for top-K and period reads", () =>
      Effect.gen(function* () {
        const { recent, aggregate } = yield* explainDashboardTransactionAccess;
        expect(recent.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
          "transactions_dashboard_recent_idx"
        );
        expect(aggregate.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
          "transactions_dashboard_period_idx"
        );
      })
    );

    it.effect("ignores more than 10,000 Transactions outside the current period", () => {
      const marker = "dashboard-scan-bound-test";
      return Effect.gen(function* () {
        yield* truncateDashboards;
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM transactions WHERE notes = ${marker}`;
        yield* sql`
          INSERT INTO transactions
            (id, user_id, amount, currency, direction, category_id, notes, occurred_at)
          SELECT
            ('30000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
            ${defaultUserId}, 1, 'COP', 'outflow', ${categoryIds.restaurantes}, ${marker},
            now() - interval '10 years'
          FROM generate_series(1, 10001) AS series
        `;

        const response = yield* HttpClient.get("/dashboard/view", {
          headers: headersFor(defaultPatBearer),
        });

        expect(response.status).toBe(200);
        const dashboardsAfterView =
          yield* sql`SELECT count(*)::int AS count FROM dashboards WHERE user_id = ${defaultUserId}`;
        expect(dashboardsAfterView[0]?.count).toBe(1);
      }).pipe(
        Effect.ensuring(
          Effect.flatMap(MigrationSqlClient, (sql) =>
            sql`DELETE FROM transactions WHERE notes = ${marker}`.pipe(Effect.orDie)
          )
        )
      );
    });

    it.effect("rolls first-use creation back when the completed projection is rejected", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const sql = yield* MigrationSqlClient;

        const outcome = yield* withUserTransaction(
          defaultUserId,
          getDashboardView({ userId: defaultUserId }).pipe(
            Effect.andThen(Effect.fail("projection rejected" as const))
          )
        ).pipe(Effect.result);
        const dashboards = yield* sql`
          SELECT count(*)::int AS count FROM dashboards WHERE user_id = ${defaultUserId}
        `;

        expect(outcome).toEqual(Result.fail("projection rejected"));
        expect(dashboards[0]?.count).toBe(0);
      })
    );

    it.effect("times out blocked acquisition and rolls first-use creation back atomically", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const admin = yield* MigrationSqlClient;
        const status = yield* admin.withTransaction(
          Effect.gen(function* () {
            const sql = yield* MigrationSqlClient;
            yield* sql`LOCK TABLE transactions IN ACCESS EXCLUSIVE MODE`;
            const response = yield* HttpClient.get("/dashboard/view", {
              headers: headersFor(defaultPatBearer),
            });
            return response.status;
          })
        );
        const dashboards = yield* admin`
          SELECT count(*)::int AS count FROM dashboards WHERE user_id = ${defaultUserId}
        `;

        expect(status).toBe(500);
        expect(dashboards[0]?.count).toBe(0);
      })
    );

    it.effect("fails closed on a malformed acquired fact and rolls first use back", () => {
      const marker = "dashboard-malformed-fact";
      return Effect.gen(function* () {
        yield* truncateDashboards;
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM transactions WHERE notes = ${marker}`;
        yield* sql`
          INSERT INTO transactions
            (user_id, amount, currency, direction, category_id, notes, occurred_at)
          VALUES
            (${defaultUserId}, 'NaN'::numeric, 'COP', 'outflow',
              ${categoryIds.restaurantes}, ${marker}, now())
        `;

        const response = yield* HttpClient.get("/dashboard/view", {
          headers: headersFor(defaultPatBearer),
        });
        const dashboards = yield* sql`
          SELECT count(*)::int AS count FROM dashboards WHERE user_id = ${defaultUserId}
        `;

        expect(response.status).toBe(500);
        expect(dashboards[0]?.count).toBe(0);
      }).pipe(
        Effect.ensuring(
          Effect.flatMap(MigrationSqlClient, (sql) =>
            sql`DELETE FROM transactions WHERE notes = ${marker}`.pipe(Effect.orDie)
          )
        )
      );
    });

    it.effect(
      "rejects aggregate Money that violates Currency precision at the repository seam",
      () => {
        const marker = "dashboard-invalid-money-precision";
        return Effect.gen(function* () {
          yield* truncateDashboards;
          const sql = yield* MigrationSqlClient;
          yield* sql`DELETE FROM transactions WHERE notes = ${marker}`;
          yield* sql`
          INSERT INTO transactions
            (user_id, amount, currency, direction, category_id, notes, occurred_at)
          VALUES
            (${defaultUserId}, 1.001, 'USD', 'outflow',
              ${categoryIds.restaurantes}, ${marker}, now())
        `;

          const response = yield* HttpClient.get("/dashboard/view", {
            headers: headersFor(defaultPatBearer),
          });
          const dashboards = yield* sql`
          SELECT count(*)::int AS count FROM dashboards WHERE user_id = ${defaultUserId}
        `;

          expect(response.status).toBe(500);
          expect(dashboards[0]?.count).toBe(0);
        }).pipe(
          Effect.ensuring(
            Effect.flatMap(MigrationSqlClient, (sql) =>
              sql`DELETE FROM transactions WHERE notes = ${marker}`.pipe(Effect.orDie)
            )
          )
        );
      }
    );

    it.effect("publishes all four valid direct-launch presets through the canonical catalog", () =>
      Effect.gen(function* () {
        const client = yield* ApiHarnessClient;

        const response = yield* client.dashboard.listDashboardCatalog();

        expect(response.data.map(({ id }) => id)).toEqual([
          "monthly-spending",
          "restaurant-budget-cop",
          "recent-transactions",
          "monthly-outflows",
        ]);
        expect(response.data.map(({ widget }) => widget.type)).toEqual([
          "spending-chart",
          "budget-bar",
          "transaction-list",
          "custom-metric",
        ]);
      })
    );

    it.effect("applies one edit to the latest document and persists the complete result", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const client = yield* ApiHarnessClient;

        const updated = yield* client.dashboard.applyDashboardEdit({
          payload: { op: "set-title", title: "Flujo de caja" },
        });
        const retained = yield* client.dashboard.getDashboard();

        expect(updated.data.title).toBe("Flujo de caja");
        expect(retained.data).toEqual(updated.data);
      })
    );

    it.effect("rolls the complete Dashboard edit back with its caller-owned transaction", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const sql = yield* MigrationSqlClient;
        const caller = freePatCaller(["dashboard"]);

        const rollback = yield* Effect.result(
          withUserTransaction(
            defaultUserId,
            applyDashboardEdit({
              userId: defaultUserId,
              caller,
              edit: { op: "set-title", title: "No debe persistir" },
            }).pipe(Effect.andThen(Effect.fail("rollback requested")))
          )
        );
        const retained = yield* sql`
          SELECT EXISTS (
            SELECT 1 FROM dashboards WHERE user_id = ${defaultUserId}
          ) AS "exists"
        `.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ exists: Schema.Boolean })))
          )
        );

        expect(rollback).toEqual(Result.fail("rollback requested"));
        expect(retained[0]?.exists).toBe(false);
      })
    );

    it.effect("rejects a malformed edit before it can change the stored document", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const client = yield* ApiHarnessClient;
        const before = yield* client.dashboard.getDashboard();

        const response = yield* HttpClient.post("/dashboard/edits", {
          headers: headersFor(defaultPatBearer),
          body: HttpBody.jsonUnsafe({ op: "set-title", title: "" }),
        });
        const failure = yield* Schema.decodeUnknownEffect(ValidationFailed)(yield* response.json);
        const after = yield* client.dashboard.getDashboard();

        expect(response.status).toBe(400);
        expect(failure.error.code).toBe("validation_failed");
        expect(failure.error.fields[0]?.path).toBe("title");
        expect(after.data).toEqual(before.data);
      })
    );

    it.effect("rolls a domain-rejected edit back without replacing the latest document", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const client = yield* ApiHarnessClient;
        const before = yield* client.dashboard.getDashboard();
        if (before.data.layout.kind !== "leaf") {
          return yield* Effect.die("expected the first-use dashboard to have one root widget");
        }

        const outcome = yield* Effect.result(
          client.dashboard.applyDashboardEdit({
            payload: {
              op: "remove-widget",
              widgetId: before.data.layout.widget.id,
            },
          })
        );
        const after = yield* client.dashboard.getDashboard();

        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isFailure(outcome)) {
          expect(Schema.is(ValidationFailed)(outcome.failure)).toBe(true);
          if (Schema.is(ValidationFailed)(outcome.failure)) {
            expect(outcome.failure.error.fields).toContainEqual({
              path: "widgetId",
              message: "Expected a removable non-final widget.",
            });
          }
        }
        expect(after.data).toEqual(before.data);
      })
    );

    it.effect("returns actionable failures for every invalid Widget target relationship", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const client = yield* ApiHarnessClient;
        const before = yield* client.dashboard.getDashboard();
        if (before.data.layout.kind !== "leaf") {
          return yield* Effect.die("expected the first-use dashboard to have one root widget");
        }
        const rootId = before.data.layout.widget.id;
        const missingId = WidgetId.make("f1d1a000-0000-4000-8000-000000000699");

        const missingEditTarget = yield* Effect.result(
          client.dashboard.applyDashboardEdit({
            payload: { op: "remove-widget", widgetId: missingId },
          })
        );
        const missingPlacementTarget = yield* Effect.result(
          client.dashboard.applyDashboardEdit({
            payload: {
              op: "add-widget",
              widget: transactionList("f1d1a000-0000-4000-8000-000000000698"),
              at: { besideWidget: missingId, axis: "row", side: "after" },
            },
          })
        );
        const duplicate = yield* Effect.result(
          client.dashboard.applyDashboardEdit({
            payload: { op: "add-widget", widget: transactionList(rootId), at: "bottom" },
          })
        );
        const rootResize = yield* Effect.result(
          client.dashboard.applyDashboardEdit({
            payload: { op: "resize-widget", widgetId: rootId, weight: SplitWeight.make(2) },
          })
        );
        const selfPlacement = yield* Effect.result(
          client.dashboard.applyDashboardEdit({
            payload: {
              op: "move-widget",
              widgetId: rootId,
              at: { besideWidget: rootId, axis: "row", side: "after" },
            },
          })
        );
        const after = yield* client.dashboard.getDashboard();

        expectNotFoundMessage(missingEditTarget, "available to edit");
        expectNotFoundMessage(missingPlacementTarget, "placement target");
        expectValidationFieldPath(duplicate, "widget.id");
        expectValidationFieldPath(rootResize, "weight");
        expectValidationFieldPath(selfPlacement, "at.besideWidget");
        expect(after.data).toEqual(before.data);
      })
    );

    it.effect("rejects an unavailable Category reference without changing the dashboard", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const client = yield* ApiHarnessClient;
        const before = yield* client.dashboard.getDashboard();
        if (before.data.layout.kind !== "leaf") {
          return yield* Effect.die("expected the first-use dashboard to have one root widget");
        }

        const outcome = yield* Effect.result(
          client.dashboard.applyDashboardEdit({
            payload: {
              op: "update-widget",
              widget: {
                id: before.data.layout.widget.id,
                type: "budget-bar",
                categoryId: CategoryId.make("f1d1a000-0000-4000-8000-00000000dead"),
                currency: "COP",
              },
            },
          })
        );
        const after = yield* client.dashboard.getDashboard();

        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isFailure(outcome)) {
          expect(Schema.is(ValidationFailed)(outcome.failure)).toBe(true);
          if (Schema.is(ValidationFailed)(outcome.failure)) {
            expect(outcome.failure.error.fields[0]?.path).toBe("widget.categoryId");
          }
        }
        expect(after.data).toEqual(before.data);
      })
    );

    it.effect("serializes concurrent edits against one User's latest document", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const client = yield* ApiHarnessClient;

        yield* Effect.all(
          [
            client.dashboard.applyDashboardEdit({
              payload: {
                op: "add-widget",
                widget: transactionList("f1d1a000-0000-4000-8000-000000000601"),
                at: "top",
              },
            }),
            client.dashboard.applyDashboardEdit({
              payload: {
                op: "add-widget",
                widget: transactionList("f1d1a000-0000-4000-8000-000000000602"),
                at: "bottom",
              },
            }),
          ],
          { concurrency: "unbounded" }
        );
        const retained = yield* client.dashboard.getDashboard();

        expect(retained.data.layout.kind).toBe("split");
        if (retained.data.layout.kind === "split") {
          expect(retained.data.layout.children).toHaveLength(3);
          expect(
            retained.data.layout.children.map(({ node }) => node.kind === "leaf" && node.widget.id)
          ).toEqual([
            "f1d1a000-0000-4000-8000-000000000601",
            expect.any(String),
            "f1d1a000-0000-4000-8000-000000000602",
          ]);
        }
      })
    );

    it.effect("gives a concurrent read either complete side of one serialized edit", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const client = yield* ApiHarnessClient;
        yield* client.dashboard.getDashboard();

        const [view] = yield* Effect.all(
          [
            client.dashboard.getDashboardView(),
            client.dashboard.applyDashboardEdit({
              payload: {
                op: "add-widget",
                widget: transactionList("f1d1a000-0000-4000-8000-000000000603"),
                at: "bottom",
              },
            }),
          ],
          { concurrency: "unbounded" }
        );
        const widgetTypes = collectWidgetViews(view.data.layout).map(({ widget }) => widget.type);

        expect([["spending-chart"], ["spending-chart", "transaction-list"]]).toContainEqual(
          widgetTypes
        );
      })
    );

    it.effect("fails closed when a Widget references a missing Category", () =>
      Effect.gen(function* () {
        const client = yield* ApiHarnessClient;
        const sql = yield* MigrationSqlClient;
        yield* truncateDashboards;
        yield* client.dashboard.getDashboard();
        yield* sql`
          UPDATE dashboards
          SET document = jsonb_set(
            document,
            '{layout,widget,categories}',
            '["f1d1a000-0000-4000-8000-00000000ca7e"]'::jsonb
          )
          WHERE user_id = ${defaultUserId}
        `;

        const response = yield* HttpClient.get("/dashboard/view", {
          headers: headersFor(defaultPatBearer),
        });

        expect(response.status).toBe(500);
      })
    );

    it.effect("fails closed when the stored JSONB is not a DashboardDocument", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const client = yield* ApiHarnessClient;
        yield* client.dashboard.getDashboard();
        const sql = yield* MigrationSqlClient;
        yield* sql`UPDATE dashboards SET document = '{"unexpected": true}'::jsonb`;

        const [documentResponse, viewResponse] = yield* Effect.all([
          HttpClient.get("/dashboard", { headers: headersFor(defaultPatBearer) }),
          HttpClient.get("/dashboard/view", { headers: headersFor(defaultPatBearer) }),
        ]);

        expect(documentResponse.status).toBe(500);
        expect(viewResponse.status).toBe(500);
      })
    );
  }
);

const DashboardClockHarness = Layer.merge(PgLive, MigrationSqlClient.layer);

layer(DashboardClockHarness, { timeout: "30 seconds" })("Dashboard operation Clock seam", (it) => {
  it.effect("uses one TestClock instant for a zone-aware PostgreSQL projection", () =>
    Effect.gen(function* () {
      const instant = DateTime.makeUnsafe("2026-03-15T12:00:00Z");
      yield* TestClock.setTime(instant.epochMilliseconds);
      yield* truncateDashboards;
      const admin = yield* MigrationSqlClient;
      yield* admin`
        UPDATE users SET time_zone = 'America/New_York' WHERE id = ${defaultUserId}
      `;

      const response = yield* withUserTransaction(
        defaultUserId,
        getDashboardView({ userId: defaultUserId })
      );
      const widget = Option.getOrThrow(Array.get(collectWidgetViews(response.data.layout), 0));
      if (!("buckets" in widget.result)) throw new Error("Expected chart result");

      expect(DateTime.formatIso(response.data.context.calculatedAt)).toBe(
        "2026-03-15T12:00:00.000Z"
      );
      expect(DateTime.formatIso(widget.result.appliedPeriod.from)).toBe("2026-03-01T05:00:00.000Z");
      expect(DateTime.formatIso(widget.result.appliedPeriod.toExclusive)).toBe(
        "2026-04-01T04:00:00.000Z"
      );
    })
  );
});
