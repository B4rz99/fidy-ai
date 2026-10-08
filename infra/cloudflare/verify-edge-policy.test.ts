import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "bccaa054048ce25c7e13eda4ca4fecdaa2c66f8e0b5c2d0403b94e1bbbcd4f3f"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
