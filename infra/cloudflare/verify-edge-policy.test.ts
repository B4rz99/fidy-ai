import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "083d7f29edc958a5c98b40d9a6df3175b20c1f05ef8040fd395834d342deae91"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
