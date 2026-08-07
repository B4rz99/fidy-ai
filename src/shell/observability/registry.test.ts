import { expect, it } from "@effect/vitest";
import { operationCatalog } from "~/shell/api";
import { TelemetryRegistry } from "./registry";

it("derives every canonical operation exactly once from the assembled API", () => {
  const canonical = operationCatalog.operations.map(({ id }) => id);

  expect(TelemetryRegistry.operation.slice(0, canonical.length)).toEqual(canonical);
  expect(new Set(TelemetryRegistry.operation).size).toBe(TelemetryRegistry.operation.length);
});

it("contains no duplicate diagnostic codes", () => {
  for (const values of Object.values(TelemetryRegistry)) {
    expect(new Set(values).size).toBe(values.length);
  }
});
