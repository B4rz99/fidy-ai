import { describe, expect, it } from "vitest";
import { edgePolicyDigest, edgePolicyIsReviewed } from "./verify-edge-policy";

describe("mandatory edge policy verification", () => {
  it("pins the complete desired policy reviewed for promotion", () => {
    expect(edgePolicyDigest).toBe(
      "681b666f2051c0705bf1ddb7f018896a21c277f28e713d9ed25b7dbc0bbcb01c"
    );
    expect(edgePolicyIsReviewed).toBe(true);
  });
});
