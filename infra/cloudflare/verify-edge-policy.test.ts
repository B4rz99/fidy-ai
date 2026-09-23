import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "d82e916a3fdd1c6cbc93fd3762a1ede4c0624255dff34a0ba68b09bb07f682d8"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
