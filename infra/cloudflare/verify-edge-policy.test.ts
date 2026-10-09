import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "b0d17e19ffb6ac69df44c4516cb0d60b4ead736169c181dc9c96c5c69ad1ad11"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
