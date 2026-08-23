import { expect, it } from "vitest";
import {
  type ContractFinding,
  type OperationPolicyManifest,
  acknowledgementCovers,
  compareOperationPolicies,
  contractAcknowledgementFrom,
  contractArtifactsFrom,
  findOpenApiBreakingChanges,
  productionWebReleaseFrom,
  removalAcknowledgementCovers,
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

it("treats an explicit default caller eligibility as equivalent to the historical omission", () => {
  const base = {
    operations: [
      {
        id: "widgets.createWidget",
        policy: { requiredScope: "write" },
      },
    ],
  } satisfies OperationPolicyManifest;
  const candidate = {
    operations: [
      {
        id: "widgets.createWidget",
        policy: { requiredScope: "write", callerEligibility: "authenticated" },
      },
    ],
  } satisfies OperationPolicyManifest;

  expect(compareOperationPolicies(base, candidate)).toEqual([]);
});

it("normalizes the legacy complete policy into equivalent canonical access", () => {
  const base = {
    operations: [
      {
        id: "widgets.createWidget",
        policy: {
          requiredScope: "write",
          scopeEvaluation: "endpoint",
          callerEligibility: "authenticated",
          requiredTier: "free",
        },
      },
      {
        id: "operations.executeAtomicBatch",
        policy: {
          requiredScope: "write",
          scopeEvaluation: "children",
          callerEligibility: "authenticated",
          requiredTier: "free",
        },
      },
      {
        id: "browserLogin.approvePairing",
        policy: {
          requiredScope: "write",
          scopeEvaluation: "endpoint",
          callerEligibility: "verified-whatsapp-hosted-only",
          requiredTier: "free",
        },
      },
    ],
  } satisfies OperationPolicyManifest;
  const candidate: OperationPolicyManifest = {
    operations: [
      {
        id: "widgets.createWidget",
        policy: {
          access: {
            type: "pat-scoped",
            scope: { evaluation: "operation", capability: "write" },
          },
          requiredTier: "free",
        },
      },
      {
        id: "operations.executeAtomicBatch",
        policy: {
          access: { type: "pat-scoped", scope: { evaluation: "children" } },
          requiredTier: "free",
        },
      },
      {
        id: "browserLogin.approvePairing",
        policy: { access: { type: "verified-whatsapp-hosted-only" }, requiredTier: "free" },
      },
    ],
  };

  expect(compareOperationPolicies(base, candidate)).toEqual([]);
});

it("reports a caller eligibility restriction on an existing operation", () => {
  const base = {
    operations: [
      {
        id: "widgets.createWidget",
        policy: { requiredScope: "write", callerEligibility: "authenticated" },
      },
    ],
  } satisfies OperationPolicyManifest;
  const candidate = {
    operations: [
      {
        id: "widgets.createWidget",
        policy: {
          requiredScope: "write",
          callerEligibility: "verified-whatsapp-hosted-only",
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
        '{"base":{"callerEligibility":"authenticated","requiredScope":"write"},"candidate":{"callerEligibility":"verified-whatsapp-hosted-only","requiredScope":"write"}}',
    },
  ]);
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

it("rejects malformed Production web release evidence", () => {
  expect(() =>
    productionWebReleaseFrom({ contractDigest: "digest", gitRevision: "revision" })
  ).toThrow("Production web release evidence");
});

it("authorizes removal only when the unchanged web and exact base contract are deployed", () => {
  const finding: ContractFinding = {
    source: "openapi",
    rule: "api-operation-removed",
    location: {},
    detail: "removed POST /widgets",
  };
  const baseDigest = "b".repeat(64);
  const candidateDigest = "c".repeat(64);
  const baseRevision = "a".repeat(40);
  const acknowledgement = {
    baseDigest,
    candidateDigest,
    findings: [finding],
    rolloutIssue: "https://github.com/B4rz99/fidy-ai/issues/999",
  };
  const deployedWeb = productionWebReleaseFrom({
    contractDigest: baseDigest,
    gitRevision: baseRevision,
  });
  const request = {
    acknowledgement,
    baseDigest,
    candidateDigest,
    findings: [finding],
    baseRevision,
    deployedWeb,
    candidateChangesWeb: false,
  };

  expect(removalAcknowledgementCovers(request)).toBe(true);
  expect(removalAcknowledgementCovers({ ...request, candidateChangesWeb: true })).toBe(false);
  expect(
    removalAcknowledgementCovers({
      ...request,
      deployedWeb: productionWebReleaseFrom({
        contractDigest: "d".repeat(64),
        gitRevision: baseRevision,
      }),
    })
  ).toBe(false);
  expect(
    removalAcknowledgementCovers({
      ...request,
      deployedWeb: productionWebReleaseFrom({
        contractDigest: baseDigest,
        gitRevision: "e".repeat(40),
      }),
    })
  ).toBe(false);
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
