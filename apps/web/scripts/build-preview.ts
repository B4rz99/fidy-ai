#!/usr/bin/env bun

import { makePreviewArchive, previewMetadata } from "./preview-artifact";

const webRoot = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const serverRoot = Bun.fileURLToPath(new URL("../../server", import.meta.url)).replace(/\/$/u, "");
const previewApiOrigin = "https://preview.invalid";

if (import.meta.main) {
  const gitRevision = Bun.env.PREVIEW_GIT_SHA;
  if (gitRevision === undefined) throw new Error("PREVIEW_GIT_SHA is required");

  const environment = Object.fromEntries(
    Object.entries(Bun.env).flatMap(([name, value]): ReadonlyArray<readonly [string, string]> =>
      typeof value === "string" ? [[name, value]] : []
    )
  );
  environment.VITE_API_ORIGIN = previewApiOrigin;
  const build = Bun.spawnSync(["bun", "--bun", "vite", "build", "--mode", "preview"], {
    cwd: webRoot,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) throw new Error("Vite preview build failed");

  const digestResult = Bun.spawnSync(["bun", "run", "contracts:digest"], {
    cwd: serverRoot,
    stderr: "inherit",
    stdout: "pipe",
  });
  if (digestResult.exitCode !== 0) throw new Error("Contract digest calculation failed");
  const canonicalContractDigest = new TextDecoder().decode(digestResult.stdout).trim();
  const metadata = previewMetadata(gitRevision, canonicalContractDigest);
  const outputDirectory = `${webRoot}/dist`;
  await Bun.write(
    `${outputDirectory}/preview-metadata.json`,
    `${JSON.stringify(metadata, null, 2)}\n`
  );
  await Bun.write(`${webRoot}/preview.tar`, await makePreviewArchive(outputDirectory));
  process.stdout.write(
    `built preview artifact for ${metadata.gitRevision} (${metadata.contractDigest})\n`
  );
}
