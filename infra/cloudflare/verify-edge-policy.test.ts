import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "82ca9af005dda256edb2ff442448b0ba21b32f066b645038e9a1a584a27b6001"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
