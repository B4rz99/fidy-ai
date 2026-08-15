import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateProductionArtifact } from "../cloudflare/production-policy/artifact";
import { releaseMetadata } from "./release-metadata";

const gitRevision = "0123456789abcdef0123456789abcdef01234567";
const contractDigest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const productionOutput = async (): Promise<string> => {
  const directory = await mkdtemp("/tmp/fidy-production-artifact-");
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "assets"));
  await Bun.write(
    join(directory, "index.html"),
    "<!doctype html><script src=/assets/app.js></script>"
  );
  await Bun.write(join(directory, "_headers"), "/*\n  X-Frame-Options: DENY\n");
  await Bun.write(
    join(directory, "deployment-metadata.json"),
    `${JSON.stringify({ contractDigest, gitRevision })}\n`
  );
  await Bun.write(join(directory, "assets/app.js"), "console.log('web')");
  return directory;
};

describe("production static release identity", () => {
  it("binds one static artifact to a full Git revision and canonical contract digest", () => {
    expect(releaseMetadata(gitRevision, contractDigest)).toEqual({
      contractDigest,
      gitRevision,
    });
  });

  it("rejects abbreviated or non-hexadecimal release identity", () => {
    expect(() => releaseMetadata("HEAD", contractDigest)).toThrow(
      "Git revision must be 40 lowercase hexadecimal characters"
    );
    expect(() => releaseMetadata(gitRevision, "digest")).toThrow(
      "Contract digest must be 64 lowercase hexadecimal characters"
    );
  });

  it("accepts only a static artifact with the expected release identity", async () => {
    const directory = await productionOutput();

    await expect(
      validateProductionArtifact({
        directory,
        expectedDigest: contractDigest,
        expectedSha: gitRevision,
      })
    ).resolves.toBeUndefined();
  });

  it("rejects server code and source maps from the production artifact", async () => {
    const directory = await productionOutput();
    await Bun.write(join(directory, "assets/server.js"), "DATABASE_URL");

    await expect(
      validateProductionArtifact({
        directory,
        expectedDigest: contractDigest,
        expectedSha: gitRevision,
      })
    ).rejects.toThrow("forbidden production artifact path");
  });
});
