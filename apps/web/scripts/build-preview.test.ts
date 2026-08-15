import { describe, expect, it } from "vitest";
import { makePreviewArchive, previewMetadata } from "./preview-artifact";

const headSha = "a".repeat(40);
const contractDigest = "b".repeat(64);

describe("preview artifact builder", () => {
  it("records the exact reviewed revision and canonical contract digest", () => {
    expect(previewMetadata(headSha, contractDigest)).toEqual({
      contractDigest,
      gitRevision: headSha,
    });
  });

  it("rejects malformed artifact identity", () => {
    expect(() => previewMetadata("HEAD", contractDigest)).toThrow("40 lowercase hexadecimal");
    expect(() => previewMetadata(headSha, "digest")).toThrow("64 lowercase hexadecimal");
  });

  it("packages only regular files below the static output root", async () => {
    const root = `${import.meta.dir}/../.preview-test-${process.pid}`;
    await Bun.$`rm -rf ${root}`.quiet();
    await Bun.write(`${root}/index.html`, "<!doctype html>", { createPath: true });
    await Bun.write(`${root}/assets/app.js`, "console.log('preview')", { createPath: true });

    try {
      const archive = await makePreviewArchive(root);
      const files = await archive.files();
      expect([...files.keys()].sort()).toEqual(["assets/app.js", "index.html"]);
    } finally {
      await Bun.$`rm -rf ${root}`.quiet();
    }
  });
});
