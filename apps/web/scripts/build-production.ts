#!/usr/bin/env bun

import { validateProductionArtifact } from "../cloudflare/production-policy/artifact";
import { releaseMetadata } from "./release-metadata";

const webRoot = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const serverRoot = Bun.fileURLToPath(new URL("../../server", import.meta.url)).replace(/\/$/u, "");
const productionApiOrigin = "https://api.fidyapp.com";

if (import.meta.main) {
  const gitRevision = Bun.env.RELEASE_GIT_SHA;
  if (gitRevision === undefined) throw new Error("RELEASE_GIT_SHA is required");

  const digestResult = Bun.spawnSync(["bun", "run", "contracts:digest"], {
    cwd: serverRoot,
    stderr: "inherit",
    stdout: "pipe",
  });
  if (digestResult.exitCode !== 0) throw new Error("Contract digest calculation failed");
  const contractDigest = new TextDecoder().decode(digestResult.stdout).trim();
  const metadata = releaseMetadata(gitRevision, contractDigest);

  const environment = Object.fromEntries(
    Object.entries(Bun.env).flatMap(([name, value]): ReadonlyArray<readonly [string, string]> =>
      typeof value === "string" ? [[name, value]] : []
    )
  );
  environment.VITE_API_ORIGIN = productionApiOrigin;
  const build = Bun.spawnSync(["bun", "--bun", "vite", "build", "--mode", "production"], {
    cwd: webRoot,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) throw new Error("Vite Production build failed");

  const outputDirectory = `${webRoot}/dist`;
  await Bun.write(
    `${outputDirectory}/deployment-metadata.json`,
    `${JSON.stringify(metadata, null, 2)}\n`
  );
  await validateProductionArtifact({
    directory: outputDirectory,
    expectedDigest: metadata.contractDigest,
    expectedSha: metadata.gitRevision,
  });
  process.stdout.write(
    `built Production artifact for ${metadata.gitRevision} (${metadata.contractDigest})\n`
  );
}
