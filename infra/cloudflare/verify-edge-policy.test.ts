import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "79cf9ff32332a1515c8aeb0a90c254fb7cbe8fdf8b063995555b5643d4f62fbe"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
