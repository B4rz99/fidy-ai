import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "a14fa306c566818e4b42c056d205245989a49a891b7ce8309d86b1618fb739aa"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
