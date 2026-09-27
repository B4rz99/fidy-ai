import { expect, it } from "vitest";
import { contractArtifactsFrom, contractDigest } from "./artifacts";

it("identifies equivalent generated contract artifacts with the same digest", () => {
  const first = contractArtifactsFrom(
    { paths: { "/b": {}, "/a": {} }, info: { title: "Fidy" } },
    { operations: [{ id: "categories.list", policy: { kind: "query", access: "read" } }] },
    "first"
  );
  const reordered = contractArtifactsFrom(
    { info: { title: "Fidy" }, paths: { "/a": {}, "/b": {} } },
    { operations: [{ policy: { access: "read", kind: "query" }, id: "categories.list" }] },
    "reordered"
  );

  expect(contractDigest(reordered)).toBe(contractDigest(first));
  expect(contractDigest(first)).toMatch(/^[0-9a-f]{64}$/u);
});

it("rejects malformed generated policy before calculating a release digest", () => {
  expect(() =>
    contractArtifactsFrom({}, { operations: [{ id: 1, policy: {} }] }, "preview")
  ).toThrow("preview operation policy is not an operation-policy manifest");
});
