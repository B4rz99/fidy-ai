import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "0cdc1fa0a45b5dd8116bba2a2fe9ff632d16970cd9e07a215d82d5abc27fbef4"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
