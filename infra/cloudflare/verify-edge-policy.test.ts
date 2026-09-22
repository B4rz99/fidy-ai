import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "7230c5c5d9144cd46518011db83543ea0ed533335ace147f04310210c7dbad67"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
