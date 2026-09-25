import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "29b974b1bbea6167dbfa4c7e20c5485e436516f2b0b5c081283b596276998ebe"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
