import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "0c1df1de422b40cecaf83e641c2f57c341f677c2f570b8238fbe1471b030cc2f"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
