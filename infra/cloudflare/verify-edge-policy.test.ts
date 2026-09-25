import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "37e65fd115c26e58552e5a05a26801c5639819e1c63edebc3e043f2f5124441d"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
