import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "5c08fd76cfd999f306646f08014cb6089de7e9c0b3f7d664d600a5ec6f68a135"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
