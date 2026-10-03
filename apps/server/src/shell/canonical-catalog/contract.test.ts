import { expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { FidyApi, operationCatalog } from "~/shell/api";
import { getAtomicBatchCallSchema } from "~/shell/operations/contract";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { makeOperationCatalog } from "./contract";
import { getCanonicalOperationInput } from "~/shell/canonical-operations/operations";
import { operationPolicy, patScoped } from "~/shell/canonical-policy/contract";

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
    _tag: "PATScoped",
    scope: { _tag: "Operation", capability: "read" },
  });
  const published = OpenApi.fromApi(api).paths["/items"]?.get;
  expect(Reflect.get(published ?? {}, "x-fidy-access")).toEqual({
    type: "pat-scoped",
    scope: { evaluation: "operation", capability: "read" },
  });
});

it("publishes the same decimal, credential and operation-id constraints that wire decoding enforces", () => {
  expect(OpenApi.fromApi(FidyApi)).toMatchObject({
    components: {
      schemas: {
        CanonicalOperationId: { pattern: "^[a-z][A-Za-z0-9]*\\.[a-z][A-Za-z0-9]*$" },
        Money: { properties: { amount: { pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$" } } },
        TokenBearer: { pattern: "^fin_[a-z0-9]{8}_[A-Za-z0-9_-]{32,}$" },
        TokenShortId: { pattern: "^[a-z0-9]{8}$" },
      },
    },
  });
});

it("keeps optional review paging and the existing UTF-16 search bounds", () => {
  const review = Schema.decodeSync(getCanonicalOperationInput("ingestion.listNeedsReviewItems"))({
    query: {},
  });
  expect(review.query).toEqual({ offset: Option.none(), limit: Option.none() });

  const search = Schema.decodeOption(getCanonicalOperationInput("transactions.searchTransactions"));
  expect(Option.isNone(search({ query: { q: "a" } }))).toBe(true);
  expect(Option.isSome(search({ query: { q: "😀" } }))).toBe(true);
  expect(Option.isNone(search({ query: { q: "a".repeat(81) } }))).toBe(true);
});

it("returns the same canonical input accepted by the published batch child schema", () => {
  const input = getCanonicalOperationInput("transactions.updateTransaction");
  const erased = operationCatalog.byId.get("transactions.updateTransaction");
  expect(input.ast).toBe(erased?.input.ast);

  const attempted = { params: { id: "not-a-transaction-id" }, payload: {} };
  const direct = Schema.decodeOption(input)(attempted);
  const batch = Schema.decodeOption(getAtomicBatchCallSchema())({
    callId: "00000000-0000-4000-8000-000000000001",
    operation: "transactions.updateTransaction",
    input: attempted,
  });
  expect(Option.isNone(direct)).toBe(true);
  expect(Option.isNone(batch)).toBe(true);
});

it("decodes a batch child with the same normalization as its typed catalog input", () => {
  const input = getCanonicalOperationInput("memory.remember");
  const attempted = { payload: { text: "  Rent is due Friday.  " } };
  const direct = Schema.decodeOption(input)(attempted);
  const batch = Schema.decodeOption(getAtomicBatchCallSchema())({
    callId: "00000000-0000-4000-8000-000000000001",
    operation: "memory.remember",
    input: attempted,
  });
  expect(Option.isSome(direct)).toBe(true);
  expect(Option.isSome(batch)).toBe(true);
  if (Option.isSome(direct) && Option.isSome(batch)) {
    expect(batch.value.input).toEqual(direct.value);
    expect(direct.value.payload.text).toBe("Rent is due Friday.");
  }
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
