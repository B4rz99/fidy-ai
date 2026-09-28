import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "e6899f77804c16800a9de497c6d72b80e875b46ed967a9b42de7c0100e2f8566"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
