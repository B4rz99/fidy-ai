import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "c3478e08bf25e4c43c2bcec1d555ebeaa6da9f3c0736a1fb051fbb61f2878cb6"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
