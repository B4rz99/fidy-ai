import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "9fcdfa1f546c38d82a683950d5935dffadd3c12dc617d3ad471b6fd072046859"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
