import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "027f428ee0a5937a7d62785c58151aa6829b1d1e9d1d4ce41e45c2a6ed9b59a5"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
