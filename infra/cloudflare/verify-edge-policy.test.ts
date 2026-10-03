import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "529d88309d420b73d99098c25907231b1ab82835bfd30d6935fff33e2504cf05"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
