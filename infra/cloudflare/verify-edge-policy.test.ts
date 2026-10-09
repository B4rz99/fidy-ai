import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "be91f5a4ed0011dc36ea68fd55c2ed64d984fc9d4666c3471b2e437ffaf2f0d9"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
