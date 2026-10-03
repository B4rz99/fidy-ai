import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "3f1915d1b5b8a0e87203299ee37ea653e37b81e1406f18dab330f3a5c01316c5"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
