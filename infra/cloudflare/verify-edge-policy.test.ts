import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "71cbc6e9478d40effa6020723c6d4767b0001febee108ecfed1dcf730cc23c8c"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
