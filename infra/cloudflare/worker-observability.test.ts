import { expect, it } from "vitest";
import { freeTierWorkerObservability } from "./worker-observability";

it("persists custom Worker logs without retaining automatic request invocations", () => {
  expect(freeTierWorkerObservability).toEqual({
    enabled: true,
    headSamplingRate: 1,
    logs: {
      enabled: true,
      headSamplingRate: 1,
      invocationLogs: false,
      persist: true,
    },
  });
});
