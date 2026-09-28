import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "43b2176e97342891b9e8be06035042616422dcedda2c1f7971270b5e7d8720a1"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
