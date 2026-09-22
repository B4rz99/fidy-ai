import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "9607275548a7bfd1a2257db7914cb3f52cde5e76ebb5ff4e631c5bbf054221a4"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
