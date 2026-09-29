import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const runDriftCheck = (plan: string, mode?: string): SpawnSyncReturns<string> => {
  const directory = mkdtempSync(join(tmpdir(), "fidy-drift-gate-"));
  try {
    writeFileSync(
      join(directory, "bun"),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$FAKE_DRIFT_PLAN\"\n",
      {
        mode: 0o700,
      }
    );
    return spawnSync("bash", ["scripts/check-topology-drift.sh", ...(mode ? [mode] : [])], {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        FAKE_DRIFT_PLAN: plan,
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("Production drift gate", () => {
  const expectedWorkerDrift =
    "[0] INFO: Plan: 2 to update\n[0] INFO: [Core] update\n[0] INFO: [Ingress] update\nsecret-attribute-do-not-print";

  it("refuses Worker drift on the normal release path", () => {
    const result = runDriftCheck(expectedWorkerDrift);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("category=drift_detected");
    expect(result.stderr).not.toContain("secret-attribute-do-not-print");
  });

  it("never exempts Worker drift even with an obsolete recovery argument", () => {
    const result = runDriftCheck(expectedWorkerDrift, "resume");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("category=drift_detected");
    expect(result.stdout).not.toContain("secret-attribute-do-not-print");
    expect(result.stderr).not.toContain("secret-attribute-do-not-print");
  });

  it("refuses another drifted resource or unexpected plan shape", () => {
    const other = runDriftCheck(`${expectedWorkerDrift}\n[0] INFO: [Assets] update`, "resume");
    expect(other.status).toBe(1);
    const changedPlan = runDriftCheck(
      expectedWorkerDrift.replace("2 to update", "3 to update"),
      "resume"
    );
    expect(changedPlan.status).toBe(1);
  });
});
