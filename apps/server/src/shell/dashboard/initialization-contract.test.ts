import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { HttpApi, HttpApiClient, OpenApi } from "effect/unstable/httpapi";
import { categoryIds } from "~/core/categories/contract";
import { WidgetId } from "~/core/dashboard/contract";
import { makeDefaultDashboard } from "~/core/dashboard/operations";
import { FidyApi, operationCatalog } from "~/shell/api";
import { canCallOperation, hostedOperationBindings } from "~/shell/canonical-operations/operations";
import { getAtomicBatchCallSchema } from "~/shell/operations/contract";
import { DashboardGroup } from "./contract";

it.effect(
  "the derived client sends explicit initialization and decodes the safe retained document",
  () =>
    Effect.gen(function* () {
      const document = makeDefaultDashboard({
        restaurantCategoryId: categoryIds.restaurantes,
        widgetIds: [
          WidgetId.make("10000000-0000-4000-8000-000000000001"),
          WidgetId.make("10000000-0000-4000-8000-000000000002"),
          WidgetId.make("10000000-0000-4000-8000-000000000003"),
          WidgetId.make("10000000-0000-4000-8000-000000000004"),
        ],
      });
      const client = yield* HttpApiClient.makeWith(
        HttpApi.make("dashboard-client-test").add(DashboardGroup),
        {
          baseUrl: "https://api.fidyapp.com",
          httpClient: HttpClient.make((request) => {
            expect(request.method).toBe("POST");
            expect(request.url).toBe("https://api.fidyapp.com/dashboard/initialize");
            expect(request.body._tag).toBe("Empty");
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json({ data: document, next: [] }))
            );
          }),
        }
      );
      const result = yield* client.dashboard.initializeDashboard();
      expect(result.data.title).toBe("Tablero");
      expect(result.data.layout).toEqual(document.layout);
      expect(result.next).toEqual([]);
    })
);

it("initialization policy and generated tools enforce dashboard capability and reject target identities", () => {
  const operation = operationCatalog.byId.get("dashboard.initializeDashboard");
  if (operation === undefined) throw new Error("Initialization declaration missing");
  expect(operation.policy.kind).toBe("mutation");
  expect(operation.atomicBatchEligible).toBe(true);
  for (const capability of ["read", "write", "dashboard"] as const) {
    expect(
      canCallOperation(operation.policy, {
        accessCaller: { _tag: "PAT", capabilities: [capability] },
        tier: "free",
      })
    ).toBe(capability === "dashboard");
  }
  expect(
    canCallOperation(operation.policy, {
      accessCaller: { _tag: "WebSession", fresh: false },
      tier: "free",
    })
  ).toBe(true);
  expect(
    hostedOperationBindings(operationCatalog).find(
      (binding) => binding.operation.id === operation.id
    )?.wireName
  ).toBe("dashboard__initializeDashboard");
  for (const input of [{ userId: "10000000-0000-4000-8000-000000000002" }, { payload: {} }]) {
    expect(Option.isNone(Schema.decodeUnknownOption(operation.input)(input))).toBe(true);
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(getAtomicBatchCallSchema())({
          callId: "10000000-0000-4000-8000-000000000001",
          operation: operation.id,
          input,
        })
      )
    ).toBe(true);
  }
  const published =
    OpenApi.fromApi(FidyApi).paths[DashboardGroup.endpoints.initializeDashboard.path]?.post;
  expect(published?.operationId).toBe(operation.id);
  expect(Reflect.get(published ?? {}, "x-fidy-access")).toEqual({
    type: "pat-scoped",
    scope: { evaluation: "operation", capability: "dashboard" },
  });
});
