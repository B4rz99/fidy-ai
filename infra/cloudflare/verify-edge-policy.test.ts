import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "8b6664ac1ad7e991ca801cef1f330f33621df24d42179604d798d58be36f5b00"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
