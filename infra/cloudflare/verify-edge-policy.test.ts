import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "3ac910f01a19b4c0b079cec988a49ccd71dcbe0433734313bf10b8b184d77f97"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
