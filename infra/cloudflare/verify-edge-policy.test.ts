import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "7ddb7d0d9cdc36baa36a5479e12f7accb78de12a3e2ab4bfc3e39de50abd5430"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
