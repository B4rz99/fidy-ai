import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "84234bda88c890a156f64cdd493651a981ca08930b685b860faf861199efcb62"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
