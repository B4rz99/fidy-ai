import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "4dd1a638ff0b7294994677d904d7abdbb8b5748afe32743ef2a19c138d7923a1"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
