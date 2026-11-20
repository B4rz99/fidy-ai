import { expect, it } from "vitest";
import * as ordinary from "./public-worker";
import * as dormant from "./fixture-fallback-ingress";

it("preserves the ordinary Ingress named entrypoints in its dormant build", () => {
  expect(Object.keys(dormant).sort()).toEqual(Object.keys(ordinary).sort());
  expect(dormant.makePublicWorker).toBe(ordinary.makePublicWorker);
  expect(dormant.default).not.toBe(ordinary.default);
});
