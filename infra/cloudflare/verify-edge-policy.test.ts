import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "d0413518f7c8cd12f362501c41bcac19fd4468b800a3cba0cb123b45d85546b2"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
