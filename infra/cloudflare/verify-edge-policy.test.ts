import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "eb51fe58a9d00eb666dcb1ac07551894b55dd58dcb4bcff4ac30830726efa2d1"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
