import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { makeOperationCatalog } from "./operation-catalog";
import { operationPolicy } from "./operation-policy";

const policy = operationPolicy({
  requiredScope: "read",
  requiredTier: "free",
  costClass: "cheap",
  agentConfirmation: "not-required",
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
