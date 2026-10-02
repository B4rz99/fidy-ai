import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "e128cd03372fac5e56dc54067bc808c7d045863a46ddf61d78ce7c940a08e62e"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
