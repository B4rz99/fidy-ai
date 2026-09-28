import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "6ca12e76f4e97b6052174ab8f401c81351db16b5c6e01066342c0086d2726571"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
