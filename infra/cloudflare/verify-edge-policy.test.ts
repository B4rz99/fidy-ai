import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "19f53757d9f09475b7eaf2274bbd8d72fe7ec6509f7103df459348e7bcf82f6b"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
