import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "b824219b6339c67143a372eabe989e940930e36e8b07b83daa9847edb3f5fc7f"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
