import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "fa914a976ee8731f22e81330c770fc19c6c7d8e71aea0de0d2c641806802f960"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
