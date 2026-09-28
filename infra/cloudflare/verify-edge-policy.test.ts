import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "1cadafa018e4e336aec248522b46035c1b3c37f4736e8a94fb0a97b1df385453"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
