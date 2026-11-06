import { expect, it } from "vitest";
import { makeHostedToolParameters } from "./operations";
import generated from "~/shell/hosted-inference/internal/tool-parameters.generated.json";

it("ships the exact current provider parameters for every hosted operation", () => {
  expect(generated).toEqual(makeHostedToolParameters());
  expect(new Set(generated.map(({ wireName }) => wireName)).size).toBe(generated.length);
});
