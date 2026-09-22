import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "b430ced905c0647a6fedbb0711d9db062c7161741f00e6ab9a5980b2bb725480"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
