import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "aa6ae643b672a371432ac49e4a30f8e0098d76517784aab55434b66c8d824bcb"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
