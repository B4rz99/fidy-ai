import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "d0b99849d9f86c521021bbc26d5207513236b3b1b4815987335c7151e22a19d0"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
