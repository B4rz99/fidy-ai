import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "11d520d6cca3d8f2218458b176ac9a6c38835831ee3b293924499ccddb4e51d2"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
