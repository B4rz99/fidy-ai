import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "d8277dfc119cf1c777f7a42bfef5f237ceef6ee5667e309f94aa2fe6b1bac526"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
