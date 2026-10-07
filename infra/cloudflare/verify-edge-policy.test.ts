import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "1a3c5a8521d2bf3cb66db626751a1aebb2fe6c97ba12c14f01b8ec6bcb94aa3c"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
