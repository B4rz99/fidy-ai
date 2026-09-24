import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "d166fb32311f52630c70909f90fada10c4185dab1f6eeef4ee7733f7c4c32d35"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
