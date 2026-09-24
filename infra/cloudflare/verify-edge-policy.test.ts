import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "b8b4e20056ab2e07dd51bb8101664090499324ada082a7438c063f2b682c6deb"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
