import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "5a2e2ba5070ef2629ac944d864996834fa6f731aa2afdca659cc78c62c934053"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
