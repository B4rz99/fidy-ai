import { stat } from "node:fs/promises";

const startupWaitMilliseconds = Number("5000");
const serverPort = 8794;

type ProofOptions = {
  readonly configPath: string;
  readonly infrastructureRoot: string;
  readonly temporaryDirectory: string;
  readonly wranglerPath: string;
};

// @effect-diagnostics-next-line asyncFunction:off -- executable Bun/Wrangler subprocess harness.
export const runProtectedDocumentProof = async (options: ProofOptions): Promise<number> => {
  const bundlePath = `${options.temporaryDirectory}/protected-document-worker.js`;
  const build = Bun.spawnSync(
    [
      options.wranglerPath,
      "deploy",
      "--dry-run",
      "--config",
      options.configPath,
      "--outfile",
      bundlePath,
    ],
    { cwd: options.infrastructureRoot, stderr: "inherit", stdout: "pipe" }
  );
  if (build.exitCode !== 0) throw new Error("Protected-document proof did not bundle");
  const bundleBytes = (await stat(bundlePath)).size;
  const worker = Bun.spawn(
    [
      options.wranglerPath,
      "dev",
      "--config",
      options.configPath,
      "--port",
      String(serverPort),
      "--persist-to",
      `${options.temporaryDirectory}/protected-state`,
      "--no-show-interactive-dev-session",
    ],
    { cwd: options.infrastructureRoot, stderr: "pipe", stdout: "pipe" }
  );
  await Bun.sleep(startupWaitMilliseconds);
  worker.kill();
  const failure = await new Response(worker.stderr).text();
  await worker.exited;
  if (!failure.includes("createRequire") || !failure.includes("runtime failed to start")) {
    throw new Error("Pinned protected-document candidate no longer has its measured failure");
  }
  return bundleBytes;
};
