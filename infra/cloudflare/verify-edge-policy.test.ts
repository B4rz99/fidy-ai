import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "68de9e25dad446cae1d736f1d687045ceaa8e510a6988dd2de348b8493fa3ff9"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
