import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "ada94c5c77a793d55d5488344de06e511445c710bcd960e138fdc81ef8143ada"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
