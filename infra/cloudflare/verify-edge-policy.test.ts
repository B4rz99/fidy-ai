import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "345388bf0d8836318c58fe14fc03a534ef2729fbba2ec145a8f11c397b7d7731"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
