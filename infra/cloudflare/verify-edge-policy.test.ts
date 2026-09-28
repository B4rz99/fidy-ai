import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "35e89763adf77c1479dc96bcfaffdb8b1ca68ecfdad2832fff1c4b4bf68f26f4"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
