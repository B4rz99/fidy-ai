import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "1c95b218ae3cacfaab1d766b9a002706f618ffe73e3158d5c08deeb34f97625f"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
