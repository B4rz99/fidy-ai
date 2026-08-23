import { expect, layer } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { MigrationSqlClient } from "~/shell/db/client";
import { CategoryId } from "~/core/categories/reference";
import { SplitWeight, TransactionListLimit, WidgetId } from "~/core/dashboard/model";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import { freePatCaller } from "~/shell/_shared/suggested-operations";
import { defaultUserId } from "~/shell/db/development-seed";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { defaultPatBearer } from "~/shell/testing/identity-fixtures";
import { ApiHarness, ApiHarnessClient, headersFor } from "~/shell/testing/api-harness";
import { truncateDashboards } from "./fixtures";
import { applyDashboardEdit } from "./mutations";

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

        expect(first.data.title).toBe("Mi tablero");
        expect(first.data.layout.kind).toBe("leaf");
        expect(second.data).toEqual(first.data);
      })
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

    it.effect("fails closed when the stored JSONB is not a DashboardDocument", () =>
      Effect.gen(function* () {
        yield* truncateDashboards;
        const client = yield* ApiHarnessClient;
        yield* client.dashboard.getDashboard();
        const sql = yield* MigrationSqlClient;
        yield* sql`UPDATE dashboards SET document = '{"unexpected": true}'::jsonb`;

        const response = yield* HttpClient.get("/dashboard", {
          headers: headersFor(defaultPatBearer),
        });

        expect(response.status).toBe(500);
      })
    );
  }
);
