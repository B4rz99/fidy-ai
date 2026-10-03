import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "1e82e4f5ca58474e348b215232af1f1be0ad8d7ec8f7648ea856f2ec3bcf95b5"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
