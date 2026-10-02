import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "98b24235709fcba112ac7c265690113c171f2209a5e0d6c05319fb2bf05d1a2f"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
