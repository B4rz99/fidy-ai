import { expect, it } from "vitest";
import { contractArtifactsFrom, contractDigest } from "./artifacts";

it("identifies equivalent generated contract artifacts with the same digest", () => {
  const first = contractArtifactsFrom({
    openapi: { paths: { "/b": {}, "/a": {} }, info: { title: "Fidy" } },
    policy: { operations: [{ id: "categories.list", policy: { kind: "query", access: "read" } }] },
    subject: "first",
  });
  const reordered = contractArtifactsFrom({
    openapi: { info: { title: "Fidy" }, paths: { "/a": {}, "/b": {} } },
    policy: { operations: [{ policy: { access: "read", kind: "query" }, id: "categories.list" }] },
    subject: "reordered",
  });

  expect(contractDigest(reordered)).toBe(contractDigest(first));
  expect(contractDigest(first)).toMatch(/^[0-9a-f]{64}$/u);
});

it("rejects malformed generated policy before calculating a release digest", () => {
  expect(() =>
    contractArtifactsFrom({
      openapi: {},
      policy: { operations: [{ id: 1, policy: {} }] },
      subject: "preview",
    })
  ).toThrow("preview operation policy is not an operation-policy manifest");
});
