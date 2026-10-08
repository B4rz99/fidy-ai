import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "8b587f39ba4f4f0d9c7a3ecd9490637efe2aa4f59fb3b38012701db869b2d4ca"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
