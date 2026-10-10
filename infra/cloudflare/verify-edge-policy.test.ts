import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "a58359cf66ef6c7cefce1a2003186c4d8949151bf169fb3b42b3f56e708a3caf"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
