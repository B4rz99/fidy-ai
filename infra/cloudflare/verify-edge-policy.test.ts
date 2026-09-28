import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "f91ce5c0e4341cb56ac485255c9e3105daa844178a45f6f428d84c06af2f2a80"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
