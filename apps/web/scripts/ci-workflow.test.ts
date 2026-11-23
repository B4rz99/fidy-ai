import { describe, expect, it } from "vitest";

const repositoryRoot = `${process.cwd()}/../..`;

const checksWorkflow = await Bun.file(`${repositoryRoot}/.github/workflows/ci.yml`).text();

describe("pull-request checks workflow policy", () => {
  it("builds the application without uploading or deploying a PR preview artifact", () => {
    const buildsJob = checksWorkflow.slice(
      checksWorkflow.indexOf("\n  builds:\n"),
      checksWorkflow.indexOf("\n  unit:\n")
    );

    expect(buildsJob).toContain("bun run verify -- --group builds");
    expect(buildsJob).not.toContain("upload-artifact");
    expect(checksWorkflow).not.toContain("build:preview");

    return Bun.file(`${repositoryRoot}/.github/workflows/preview.yml`)
      .exists()
      .then((exists) => expect(exists).toBe(false));
  });

  it("leaves the required merge context to the default-branch workflow", () =>
    Bun.file(`${repositoryRoot}/.github/workflows/merge-gate.yml`)
      .text()
      .then((mergeGate) => {
        expect(checksWorkflow).not.toContain("required-checks:");
        expect(checksWorkflow).not.toContain("check-ci-results.sh");
        expect(checksWorkflow).not.toContain("REQUIRED_CHECK_SCRIPT");
        expect(mergeGate).toContain('workflows: ["Checks"]');
        expect(mergeGate).toContain("types: [completed]");
        expect(mergeGate).toContain("statuses: write");
        expect(mergeGate).toContain("run: bun scripts/merge-gate.ts");
        expect(mergeGate).toContain(
          "PR_NUMBER: ${{ github.event.workflow_run.pull_requests[0].number }}"
        );
      }));

  it("runs native conformance from a same-run bundle without installing platform workspace dependencies", () => {
    const packageJob = checksWorkflow.slice(
      checksWorkflow.indexOf("\n  cli-native-package:\n"),
      checksWorkflow.indexOf("\n  cli-native:\n")
    );

    const nativeJob = checksWorkflow.slice(checksWorkflow.indexOf("\n  cli-native:\n"));

    expect(packageJob).toContain("runs-on: ubuntu-latest");
    expect(packageJob).toContain("bun run --cwd apps/cli build:native");
    expect(packageJob).toContain("if-no-files-found: error");
    expect(nativeJob).toContain("needs: [changes, cli-native-package]");
    expect(nativeJob).toContain("./.github/actions/bun-runtime");
    expect(nativeJob).toContain("actions/download-artifact@");
    expect(nativeJob).toContain("bun test-results/cli-native/native-store.js");
    expect(nativeJob).not.toContain("bun-install");
    expect(nativeJob).not.toContain("run-id:");
    expect(nativeJob).not.toContain("repository:");
    expect(checksWorkflow).toContain("cli-native-package: ${{ steps.plan.outputs.cli-native }}");
    expect(checksWorkflow).toContain("cli-native: ${{ steps.plan.outputs.cli-native }}");
  });

  it("runs mutation testing weekly on Sundays without blocking pull requests", () => {
    expect(checksWorkflow).not.toContain("test:mutation");

    return Bun.file(`${repositoryRoot}/.github/workflows/mutation.yml`)
      .text()
      .then((workflow) => {
        expect(workflow).toContain('cron: "17 5 * * 0"');
        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).not.toContain("pull_request:");
        expect(workflow).toContain("run: bun run test:mutation");
      });
  });

  it("pins every external Action to a complete commit SHA", () => {
    const externalActions = Array.from(
      checksWorkflow.matchAll(/^\s+(?:- )?uses: ([^./][^@\s]+)@([^\s#]+)/gmu)
    );

    expect(externalActions.length).toBeGreaterThan(0);

    for (const action of externalActions) {
      expect(action[2]).toMatch(/^[0-9a-f]{40}$/u);
    }
  });
});
