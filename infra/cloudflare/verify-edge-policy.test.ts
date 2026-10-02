import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "d961cd11d55947d6c05b1e81827bd9e4c378ba4d6d817a54f601ceabe39cc5bb"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
