import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { makeOperationCatalog } from "./operation-catalog";
import { operationPolicy, patScoped } from "./operation-policy";

const policy = operationPolicy({
  access: patScoped("read"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "query",
});

it("reads inherited descriptive metadata through reflected annotations", () => {
  const endpoint = HttpApiEndpoint.get("inspectItems", "/items", {
    success: Schema.Void,
  }).annotateMerge(policy);
  const api = HttpApi.make("inherited-description-test").add(
    HttpApiGroup.make("testing")
      .add(endpoint)
      .annotate(OpenApi.Description, "Inspect the available items before choosing one.")
  );

  const reflected = makeOperationCatalog(api).operations[0];

  expect(reflected?.description).toBe("Inspect the available items before choosing one.");
  expect(reflected?.policy.kind).toBe("query");
  expect(reflected?.policy.access).toEqual({
    _tag: "PatScoped",
    scope: { _tag: "Operation", capability: "read" },
  });
  const published = OpenApi.fromApi(api).paths["/items"]?.get;
  expect(Reflect.get(published ?? {}, "x-fidy-access")).toEqual({
    type: "pat-scoped",
    scope: { evaluation: "operation", capability: "read" },
  });
});

it("rejects an OpenAPI operation id that is not the group-qualified identifier", () => {
  const endpoint = HttpApiEndpoint.get("inspectItems", "/items", {
    success: Schema.Void,
  })
    .annotate(OpenApi.Identifier, "items.override")
    .annotateMerge(policy);
  const api = HttpApi.make("operation-id-test").add(HttpApiGroup.make("testing").add(endpoint));

  expect(() => makeOperationCatalog(api)).toThrow(
    "Canonical operations must publish their group-qualified identifier: testing.inspectItems"
  );
});
