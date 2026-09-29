import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("refuses an invalid manual source run before running any Cloudflare command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fidy-rollback-"));
    try {
      const runFile = join(directory, "run.json");
      const receiptFile = join(directory, "receipt.json");
      await Bun.write(runFile, JSON.stringify({ ...run, head_branch: "untrusted" }));
      await Bun.write(receiptFile, JSON.stringify(receipt));
      const child = Bun.spawn(["bun", "verify-rollback-receipt.ts", runFile, receiptFile], {
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(await new Response(child.stderr).text()).toContain("Worker traffic unchanged");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("admits only a trunk production push receipt matching its run revision", () => {
    expect(verifyRollbackReceipt(run, receipt)).toBe(true);
    expect(verifyRollbackReceipt({ ...run, head_branch: "feature" }, receipt)).toBe(false);
    expect(verifyRollbackReceipt({ ...run, head_sha: "d".repeat(40) }, receipt)).toBe(false);
    expect(verifyRollbackReceipt({ ...run, name: "Another workflow" }, receipt)).toBe(false);
    expect(verifyRollbackReceipt({ ...run, event: "workflow_dispatch" }, receipt)).toBe(false);
  });
});
