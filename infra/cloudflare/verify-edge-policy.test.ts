import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "6dc1a479b4a6d00cd42d6e7e68a8e65a48d0948da7f35538037ce82e1e169e28"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
