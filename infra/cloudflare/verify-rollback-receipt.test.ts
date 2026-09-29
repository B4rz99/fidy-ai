import { describe, expect, it } from "vitest";
import { verifyRollbackReceipt } from "./verify-rollback-receipt";

const revision = "a".repeat(40);
const stable = "11111111-1111-4111-8111-111111111111";
const candidate = "22222222-2222-4222-8222-222222222222";
const run = { name: "Deploy Production", head_branch: "trunk", head_sha: revision, event: "push" };
const receipt = {
  release: {
    snapshot: {
      revision,
      stableRevision: "b".repeat(40),
      stableContractDigest: "c".repeat(64),
      public: { name: "fidy-ingress", deploymentId: stable, stableVersionId: stable },
      core: { name: "fidy-core", deploymentId: stable, stableVersionId: stable },
    },
    publicVersionId: candidate,
    coreVersionId: candidate,
    publicDeploymentId: stable,
    coreDeploymentId: stable,
  },
  promoted: { publicDeploymentId: candidate, coreDeploymentId: candidate },
};

describe("manual rollback receipt admission", () => {
  it("refuses an unavailable manual source run before running any Cloudflare command", () => {
    const child = Bun.spawnSync(
      ["bun", "verify-rollback-receipt.ts", "missing-source-run.json", "missing-receipt.json"],
      {
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(child.exitCode).toBe(1);
    expect(new TextDecoder().decode(child.stdout)).toBe("");
    expect(new TextDecoder().decode(child.stderr)).toContain("Worker traffic unchanged");
  });

  it("admits only a trunk production push receipt matching its run revision", () => {
    expect(verifyRollbackReceipt({ run, receipt })).toBe(true);
    expect(verifyRollbackReceipt({ run: { ...run, head_branch: "feature" }, receipt })).toBe(false);
    expect(verifyRollbackReceipt({ run: { ...run, head_sha: "d".repeat(40) }, receipt })).toBe(
      false
    );
    expect(verifyRollbackReceipt({ run: { ...run, name: "Another workflow" }, receipt })).toBe(
      false
    );
    expect(verifyRollbackReceipt({ run: { ...run, event: "workflow_dispatch" }, receipt })).toBe(
      false
    );
  });
});
