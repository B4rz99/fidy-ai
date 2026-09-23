import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "b3cf7662520c4a5cd67d8ad1cac6e40eca2b5b0dcd3751e9ff069e2fd9e5bb05"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
