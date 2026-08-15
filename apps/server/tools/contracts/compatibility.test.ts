import { expect, it } from "vitest";
import {
  type ContractFinding,
  type OperationPolicyManifest,
  acknowledgementCovers,
  compareOperationPolicies,
  contractAcknowledgementFrom,
  contractArtifactsFrom,
  findOpenApiBreakingChanges,
} from "./compatibility";

const operation = (
  requestSchema: object = { type: "object", properties: {} },
  responseSchema: object = {
    type: "object",
    properties: { value: { type: "string" } },
  }
): object => ({
  post: {
    operationId: "widgets.createWidget",
    requestBody: {
      required: true,
      content: { "application/json": { schema: requestSchema } },
    },
    responses: {
      "200": {
        description: "ok",
        content: { "application/json": { schema: responseSchema } },
      },
    },
  },
});

const spec = (paths: object): object => ({
  openapi: "3.1.0",
  info: { title: "fixture", version: "1" },
  paths,
});

it.each([
  {
    name: "removed operations",
    base: spec({ "/widgets": operation() }),
    candidate: spec({}),
  },
  {
    name: "newly required inputs",
    base: spec({ "/widgets": operation() }),
    candidate: spec({
      "/widgets": operation({
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      }),
    }),
  },
  {
    name: "narrowed input schemas",
    base: spec({
      "/widgets": operation({
        type: "object",
        properties: { kind: { type: "string", enum: ["small", "large"] } },
      }),
    }),
    candidate: spec({
      "/widgets": operation({
        type: "object",
        properties: { kind: { type: "string", enum: ["small"] } },
      }),
    }),
  },
  {
    name: "incompatible responses",
    base: spec({ "/widgets": operation() }),
    candidate: spec({
      "/widgets": operation(undefined, {
        type: "object",
        properties: { value: { type: "number" } },
      }),
    }),
  },
])("detects $name", async ({ base, candidate }) => {
  const findings = await findOpenApiBreakingChanges(base, candidate);

  expect(findings.length).toBeGreaterThan(0);
  expect(findings.every((finding) => finding.source === "openapi")).toBe(true);
  expect(findings.every((finding) => finding.rule.length > 0)).toBe(true);
});

it("rejects malformed generated contract artifacts at the contract boundary", () => {
  expect(() =>
    contractArtifactsFrom(
      { openapi: "3.1.0" },
      { operations: [{ id: 42, policy: {} }] },
      "candidate"
    )
  ).toThrow("operation policy");
});

it("rejects malformed compatibility acknowledgements at the acknowledgement boundary", () => {
  expect(() =>
    contractAcknowledgementFrom({
      baseDigest: "base",
      candidateDigest: "candidate",
      findings: [{ source: "openapi", rule: "removed", detail: "removed", location: [] }],
      rolloutIssue: "https://github.com/B4rz99/fidy-ai/issues/269",
    })
  ).toThrow("exact-finding acknowledgement");
});

it("compares the complete reflected policy value without a field allowlist", () => {
  const base = {
    operations: [
      {
        id: "widgets.createWidget",
        policy: {
          requiredScope: "transactions:write",
          accessRequirement: { _tag: "User", futureVariant: { mode: "strict" } },
        },
      },
    ],
  } satisfies OperationPolicyManifest;
  const candidate = {
    operations: [
      {
        id: "widgets.createWidget",
        policy: {
          requiredScope: "transactions:write",
          accessRequirement: { _tag: "User", futureVariant: { mode: "relaxed" } },
        },
      },
    ],
  } satisfies OperationPolicyManifest;

  expect(compareOperationPolicies(base, candidate)).toEqual([
    {
      source: "operation-policy",
      rule: "operation-policy-changed",
      operationId: "widgets.createWidget",
      detail:
        '{"base":{"accessRequirement":{"_tag":"User","futureVariant":{"mode":"strict"}},"requiredScope":"transactions:write"},"candidate":{"accessRequirement":{"_tag":"User","futureVariant":{"mode":"relaxed"}},"requiredScope":"transactions:write"}}',
    },
  ]);
});

it("requires an acknowledgement to match both digests, every exact finding, and a rollout issue", () => {
  const finding: ContractFinding = {
    source: "openapi",
    rule: "api-operation-removed",
    location: {
      operationId: "widgets.createWidget",
      operation: "POST",
      path: "/widgets",
      section: "paths",
      fingerprint: "fixture-fingerprint",
    },
    detail: "removed POST /widgets",
  };
  const acknowledgement = {
    baseDigest: "base-digest",
    candidateDigest: "candidate-digest",
    findings: [finding],
    rolloutIssue: "https://github.com/B4rz99/fidy-ai/issues/999",
  };

  expect(
    acknowledgementCovers({
      acknowledgement,
      baseDigest: "base-digest",
      candidateDigest: "candidate-digest",
      findings: [finding],
    })
  ).toBe(true);
  expect(
    acknowledgementCovers({
      acknowledgement,
      baseDigest: "different-base",
      candidateDigest: "candidate-digest",
      findings: [finding],
    })
  ).toBe(false);
  expect(
    acknowledgementCovers({
      acknowledgement,
      baseDigest: "base-digest",
      candidateDigest: "candidate-digest",
      findings: [{ ...finding, detail: "a later unrelated break" }],
    })
  ).toBe(false);
  expect(
    acknowledgementCovers({
      acknowledgement: { ...acknowledgement, rolloutIssue: "later" },
      baseDigest: "base-digest",
      candidateDigest: "candidate-digest",
      findings: [finding],
    })
  ).toBe(false);
});
