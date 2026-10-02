import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "916910b2847d1af2848d98c256fa17c8bb9a8a23f7181a4f8a088ca18ec6b9b1"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
