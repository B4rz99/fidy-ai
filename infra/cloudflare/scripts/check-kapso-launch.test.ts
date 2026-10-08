import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./check-kapso-launch.sh", import.meta.url));
const ready = {
  reviewedAt: "2026-10-01",
  reviewer: "operator",
  contractingEntity: "Kapso, Inc.",
  termsEvidence: "restricted/accepted-terms",
  dpaEvidence: "restricted/accepted-dpa",
  subprocessorsEvidence: "restricted/subprocessors-review",
  transcriptProvider: "Kapso-configured provider",
  transcriptConfigurationEvidence: "restricted/transcription-setting",
  retentionDays: 30,
  retentionEvidence: "restricted/retention-setting",
  unusedFeaturesEvidence: "restricted/feature-review",
  unusedFeatures: {
    agents: "disabled",
    models: "disabled",
    workflows: "disabled",
    replay: "disabled",
    sandbox: "disabled",
    mcp: "disabled",
    analytics: "disabled",
  },
  deletionTestEvidence: "restricted/deletion-test",
  policyRevision: "policy-2026-09-28-cloudflare-providers",
  onboardingRevision: "onboarding-2026-10-08-providers",
};

const check = (evidence: unknown): { readonly code: number; readonly output: string } => {
  const directory = mkdtempSync(join(tmpdir(), "kapso-gate-"));
  try {
    const path = join(directory, "evidence.json");
    writeFileSync(path, JSON.stringify(evidence));
    const result = spawnSync("bash", [script, path], { encoding: "utf8" });
    return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("Kapso production launch check", () => {
  it("keeps the real-user launch check pending without blocking MVP deployments", () => {
    const evidence: unknown = JSON.parse(
      readFileSync(
        new URL("../../../docs/operations/kapso-launch-evidence.json", import.meta.url),
        "utf8"
      )
    );
    expect(check(evidence).code).toBe(1);
    const workflow = readFileSync(
      new URL("../../../.github/workflows/production.yml", import.meta.url),
      "utf8"
    );
    expect(workflow).not.toContain("bash infra/cloudflare/scripts/check-kapso-launch.sh");
  });

  it("refuses the unreviewed launch record", () => {
    const result = check({ ...ready, deletionTestEvidence: "PENDING" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("category=kapso_launch_not_verified");
    expect(result.output).not.toContain("restricted/");
  });

  it("refuses indefinite retention even with other evidence", () => {
    expect(check({ ...ready, retentionDays: null }).code).toBe(1);
  });

  it("refuses an unchecked feature even when retention is finite", () => {
    expect(
      check({ ...ready, unusedFeatures: { ...ready.unusedFeatures, mcp: "PENDING" } }).code
    ).toBe(1);
  });

  it("refuses a disclosure that does not match the shipped revision", () => {
    expect(check({ ...ready, policyRevision: "old-policy" }).code).toBe(1);
  });

  it("accepts reviewed finite retention and matching disclosures", () => {
    const result = check(ready);
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("restricted/");
  });
});
