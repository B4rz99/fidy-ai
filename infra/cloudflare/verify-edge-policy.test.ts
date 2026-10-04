import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "47c24e6708a858a9b81b10b076e97c3fe7c5bf433ac61d6668c5239a6f393846"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
