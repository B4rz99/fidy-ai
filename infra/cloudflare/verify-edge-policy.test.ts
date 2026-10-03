import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "7b7082f3d3a91a3fb0d2443f4534d6f0f06f2d69451d27a96d3d14c6b0a10dd8"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
