import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "d3446ae4886aedf83bc93f329f8779188261f3363355060d79f44a7c0f4bc373"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
