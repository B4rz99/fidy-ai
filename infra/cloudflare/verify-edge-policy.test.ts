import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "6e7810c3489aa02ce345e1cdb54d465959096a7b4689e255be706f0393163ba1"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
