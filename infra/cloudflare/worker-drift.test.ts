import { describe, expect, it } from "vitest";
import { workerDriftFields, workerDriftReport } from "./worker-drift";

describe("Worker drift field projection", () => {
  it("reports only the release pair from a decoded plan, not foreign resource names or values", () => {
    const drift = { expected: { versionId: "secret-value" }, actual: {} };
    expect(
      workerDriftReport({
        resources: {
          core: { resource: { LogicalId: "Core" }, drift },
          ingress: { resource: { LogicalId: "Ingress" }, drift },
          other: { resource: { LogicalId: "foreign-name" }, drift },
        },
      })
    ).toEqual(["Worker drift fields: Core versionId", "Worker drift fields: Ingress versionId"]);
    expect(workerDriftReport({ resources: "secret-invalid-body" })).toEqual([
      "Worker drift fields: Core unavailable",
      "Worker drift fields: Ingress unavailable",
    ]);
  });
  it("identifies missing upload receipts without exporting their values", () => {
    const actual = { workerName: "worker", hash: { bundle: "digest" } };
    const expected = {
      ...actual,
      versionId: "private-version",
      deploymentId: "private-deployment",
    };
    expect(workerDriftFields({ expected, actual })).toEqual(["versionId", "deploymentId"]);
  });

  it("collapses hostile unknown keys to other and never exports names or values", () => {
    expect(
      workerDriftFields({
        expected: { tags: ["secret-tag"], "secret-field-name": "secret-provider-value" },
        actual: { tags: [] },
      })
    ).toEqual(["tags", "other"]);
  });

  it("distinguishes unchanged attributes from unavailable observations", () => {
    expect(workerDriftFields({ expected: { urls: [] }, actual: { urls: [] } })).toEqual([]);
    expect(workerDriftFields({ expected: { urls: [] }, actual: undefined })).toEqual([
      "unavailable",
    ]);
  });
});
