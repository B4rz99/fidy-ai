import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "5ba17e42d66b38963adbd3fbfa345fffe77d4edadafc1c909c34b98aa12e709e"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
