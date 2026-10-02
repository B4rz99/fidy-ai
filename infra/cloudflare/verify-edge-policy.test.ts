import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "96185c283ee8bed75778cc83d2d640029bc6dd3ca3664891a323057fe1126cbc"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
