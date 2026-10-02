import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "4732d1f8710471bb7583b02df4433559c48b2ef8d1abcb0fac41b68d6472a3ee"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
