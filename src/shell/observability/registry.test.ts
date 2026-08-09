import { expect, it } from "@effect/vitest";
import { HttpApi } from "effect/unstable/httpapi";
import { CanonicalTelemetry } from "~/shell/_shared/canonical-telemetry";
import { ErrorCode } from "~/shell/_shared/errors";
import { FidyApi, operationCatalog } from "~/shell/api";
import { TelemetryRegistry } from "./registry";

it("derives every canonical operation exactly once from the assembled API", () => {
  const canonical = operationCatalog.operations.map(({ id }) => id);

  expect(TelemetryRegistry.operation.slice(0, canonical.length)).toEqual(canonical);
  expect(new Set(TelemetryRegistry.operation).size).toBe(TelemetryRegistry.operation.length);
});

it("attaches the Telemetry seam to every canonical operation", () => {
  const observed: Array<string> = [];
  HttpApi.reflect(FidyApi, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, group }) => {
      if (endpoint.middlewares.has(CanonicalTelemetry)) {
        observed.push(`${group.identifier}.${endpoint.identifier}`);
      }
    },
  });

  expect(observed).toEqual(operationCatalog.operations.map(({ id }) => id));
});

it("admits every declared API outcome as a fixed telemetry code", () => {
  expect(TelemetryRegistry.error.slice(0, ErrorCode.literals.length)).toEqual(ErrorCode.literals);
});

it("contains no duplicate diagnostic codes", () => {
  for (const values of Object.values(TelemetryRegistry)) {
    expect(new Set(values).size).toBe(values.length);
  }
});
