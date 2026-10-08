import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "55ceebdeae1346e5e9f4c07b5e3e69a7a7c062a1a62e108ead4554a55daa9134"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
