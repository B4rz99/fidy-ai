import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "d5ac11eb4201801694205e9d22d05d610fec936fe56f579ed32a30383b7207cf"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
