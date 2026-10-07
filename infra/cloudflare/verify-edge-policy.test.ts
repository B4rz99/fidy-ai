import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "4dd7632d233f9ed42ad482cdec59c0f187b309a5be9cf7b841f3020f823a3472"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
