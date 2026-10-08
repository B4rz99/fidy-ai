import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "1e9e8d312ba9d716443225c86eeab7c89a585c0a6b374d27bfd219495fec50e9"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
