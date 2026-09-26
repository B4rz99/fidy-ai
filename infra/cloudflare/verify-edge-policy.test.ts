import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "07147ad8c57c7622ddd8cd96f4bcf626c6eb569b833e766a0965d034a25dcff8"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
