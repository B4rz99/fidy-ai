import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "3d640b83e538dda55a223b784301621fc12fde1727210547e269c6bb456cad42"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
