import { describe, expect, it } from "vitest";

const repositoryRoot = new URL("../../../", import.meta.url);

const source = (path: string): Promise<string> => Bun.file(new URL(path, repositoryRoot)).text();

const workflow = await source(".github/workflows/native-storage-release.yml");

const checks = await source(".github/workflows/ci.yml");

const cliRelease = await source(".github/workflows/cli-release.yml");

const profileAction = await source(
  ".github/actions/configure-alchemy-cloudflare-profile/action.yml"
);

const ordered = (text: string, parts: readonly string[]): void => {
  let previous = -1;

  for (const part of parts) {
    const next = text.indexOf(part);
    expect(next, part).toBeGreaterThan(previous);
    previous = next;
  }
};

describe("protected native releases", () => {
  it("requires an explicit protected trunk dispatch, serialized with all production writers", () => {
    for (const gate of [
      "workflow_dispatch:",
      "github.ref == 'refs/heads/trunk'",
      "environment: production",
      "group: production-deployment",
      "cancel-in-progress: false",
      "persist-credentials: false",
    ]) {
      expect(workflow).toContain(gate);
    }

    expect(workflow).not.toContain("  push:");
    expect(workflow).not.toMatch(
      /production-resources.ts|verify-retirement|deferred-d1-quota|SCHEMA_CUTOVER/u
    );
  });
  it("pins every external Action and builds release metadata before the first provider mutation", () => {
    const external = Array.from(
      workflow.matchAll(/uses: ([^\s]+)/gu),
      (action) => action[1] ?? ""
    ).filter((name) => !name.startsWith("./"));

    for (const name of external) {
      expect(name).toMatch(/@[a-f0-9]{40}$/u);
    }

    ordered(workflow, [
      "Require closed admission",
      "actions/checkout@",
      "Bind evidence to the protected revision",
      "RELEASE_SNAPSHOT_FILE=$RUNNER_TEMP",
      "Check the reviewed release policy",
      "native-storage-resources.ts first-install",
    ]);
    expect(workflow).toContain("RELEASE_GIT_SHA: ${{ github.sha }}");
    expect(workflow).toContain("SMOKE_PROOF: ${{ secrets.NATIVE_STORAGE_SMOKE_PROOF }}");
    expect(profileAction).toContain("ALCHEMY_HOME=$RUNNER_TEMP/alchemy");
    expect(profileAction).toContain("apiToken=env:CLOUDFLARE_API_TOKEN");
  });
  it("verifies candidate and mixed owner versions before promotion and permits only proven rollback", () => {
    ordered(workflow, [
      "native-storage-release.ts capture",
      "native-storage-resources.ts upload",
      "native-storage-release.ts stage",
      "native-storage-release.ts promote",
      "native-storage-release.ts verify",
      "steps.promote.outcome == 'success' && steps.verify.outcome == 'failure'",
      "native-storage-release.ts rollback",
      "name: native-storage-release-${{ github.run_id }}",
    ]);
  });
  it("reserves physical erasure for first installation and an explicit erasure dispatch", () => {
    ordered(workflow, [
      "id: verify",
      "if: inputs.operation != 'plan-fixture-fallback' && inputs.operation != 'plan-first-install' && inputs.operation != 'first-install' && inputs.operation != 'verify-erasure'",
      "run: bun native-storage-release.ts verify\n",
      "if: inputs.operation == 'first-install' || inputs.operation == 'verify-erasure'",
      "run: bun native-storage-release.ts verify-erasure\n",
      "steps.promote.outcome == 'success' && steps.verify.outcome == 'failure'",
    ]);
  });
  it("limits host staging to the verified native scope and rechecks the installed browser", () => {
    ordered(workflow, [
      "bun run build:production",
      "bun native-storage-resources.ts stage-hosts",
      "bun native-storage-release.ts attach-hosts",
      "bun native-storage-release.ts verify",
    ]);
    expect(workflow).toContain('test "$NATIVE_STORAGE_ADMISSION" = closed');
  });
  it("validates code only before merge and publishes CLI releases from protected trunk", () => {
    expect(checks).toContain("  pull_request:");
    expect(checks).not.toContain("  push:");
    expect(cliRelease).toContain("  push:\n    branches: [trunk]");
    expect(cliRelease).not.toContain("workflow_run");
    expect(cliRelease).toContain("ref: ${{ github.sha }}");
    expect(cliRelease).toContain("SOURCE_SHA: ${{ github.sha }}");
  });

  it("keeps ordinary tests in PR validation and builds the exact production artifacts", () => {
    for (const group of ["builds", "cloudflare-adapters", "cloudflare-infra"]) {
      expect(checks).toContain("bun run verify -- --group " + group);
    }

    expect(workflow).toContain("run: bun run build:production");
  });
});
