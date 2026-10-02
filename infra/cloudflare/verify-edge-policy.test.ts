import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "5382d06f51fe84053c11fd9ed29b86b32a2c51e0b0032ddb56cabf03acf4b8c5"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
