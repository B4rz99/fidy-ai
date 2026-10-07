import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "7bcdd52d470e83b14bc3a665264007a1834d3008ef82cd74dc87727ebb62d61f"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
