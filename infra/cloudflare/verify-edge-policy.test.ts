import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "cd5f4a3cc02beb2361ee54a18d74c0c4f841683f8bf2ba97d0dd9a975653e4a5"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
