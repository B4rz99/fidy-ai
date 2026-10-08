import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "007610d8ab24deb43c744a9ecf25102308bdc158dff5ef8b9b023fde11202a1b"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
