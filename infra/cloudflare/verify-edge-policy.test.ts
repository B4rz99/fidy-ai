import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "846bae8cd07370a086aedd8ea853a4ec6aa88dce439a313ce2c541eb345bd80b"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
