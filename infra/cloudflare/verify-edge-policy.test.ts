import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "a3f5f5ff95067e96b5dd308f7d32de0432b3e9fe73e4440448a9bc7537ac79bd"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
