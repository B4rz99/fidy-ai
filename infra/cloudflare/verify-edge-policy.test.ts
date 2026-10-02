import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "9d639008e732834d7eb1108bb2e04f0a3c5325ddd6609caff0c78a8fcc967e23"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
