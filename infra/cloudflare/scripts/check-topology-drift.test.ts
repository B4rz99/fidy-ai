import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./check-topology-drift.sh", import.meta.url));
const workingDirectory = fileURLToPath(new URL("../", import.meta.url));

const runDriftGate = async (input: {
  output: string;
  exitCode: number;
}): Promise<{
  readonly args: string;
  readonly exitCode: number;
  readonly output: string;
}> => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "fidy-topology-drift-"));
  const fakeBin = join(temporaryDirectory, "bin");
  const fakeBun = join(fakeBin, "bun");
  const fixturePath = join(temporaryDirectory, "alchemy-output.txt");
  const argsPath = join(temporaryDirectory, "alchemy-args.txt");

  try {
    await mkdir(fakeBin);
    await writeFile(fixturePath, input.output);
    await writeFile(
      fakeBun,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > "$DRIFT_ARGS"\ncat "$DRIFT_FIXTURE"\nexit "$DRIFT_EXIT_CODE"\n',
      { mode: 0o755 }
    );

    const result = spawnSync("bash", [scriptPath], {
      cwd: workingDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        DRIFT_EXIT_CODE: String(input.exitCode),
        DRIFT_ARGS: argsPath,
        DRIFT_FIXTURE: fixturePath,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });

    return {
      args: await readFile(argsPath, "utf8"),
      exitCode: result.status ?? 1,
      output: `${result.stdout}${result.stderr}`,
    };
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
};

describe("Production topology drift gate", () => {
  it("accepts only a successful no-change plan", async () => {
    const result = await runDriftGate({
      exitCode: 0,
      output: "[14:00:00] INFO: Plan: no changes\n",
    });

    expect(result.exitCode).toBe(0);
    expect(result.args).toContain(
      "drift --config alchemy-drift.run.ts --stage production --no-input"
    );
    expect(result.output).toContain("Production Cloudflare topology has no drift.");
  });

  it("rejects a drift plan without exposing its resource attributes", async () => {
    const result = await runDriftGate({
      exitCode: 0,
      output:
        "[14:00:00] INFO: Plan: 1 to update\n" +
        "[14:00:00] INFO: [FidyCloudflare/production/Core] update\n" +
        "  API_TOKEN: provider-private-payload\n",
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("category=drift_detected");
    expect(result.output).not.toContain("FidyCloudflare/production/Core");
    expect(result.output).not.toContain("provider-private-payload");
  });

  it("classifies a failed Alchemy command without echoing its captured error", async () => {
    const result = await runDriftGate({
      exitCode: 17,
      output: "error: ConfigError: missing required configuration\n" + "provider-private-payload\n",
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("category=configuration");
    expect(result.output).not.toContain("provider-private-payload");
    expect(result.output).not.toContain("missing required configuration");
  });
});
