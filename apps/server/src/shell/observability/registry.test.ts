import { CanonicalTelemetry } from "~/shell/public-http/contract";
import { expect, it } from "@effect/vitest";
import { HttpApi } from "effect/http-api";

import { FidyApi, operationCatalog } from "~/shell/api";
import { TelemetryRegistry } from "./contract";

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

it("contains no duplicate diagnostic codes", () => {
  for (const values of Object.values(TelemetryRegistry)) {
    expect(new Set(values).size).toBe(values.length);
  }
});
