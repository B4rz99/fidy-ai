import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "03cbe70c3731d87bc06e371b086fe0540c9536dbe807d51fa886c25ebd7ea4cd"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
