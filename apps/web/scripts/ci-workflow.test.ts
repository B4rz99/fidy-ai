import { describe, expect, it } from "vitest";

const repositoryRoot = `${process.cwd()}/../..`;
const checksWorkflow = await Bun.file(`${repositoryRoot}/.github/workflows/ci.yml`).text();
const bunInstallAction = await Bun.file(
  `${repositoryRoot}/.github/actions/bun-install/action.yml`
).text();

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

  it("keeps the required checks focused on static and browser validation", () => {
    expect(checksWorkflow).not.toContain("server-runtime:");
    expect(checksWorkflow).not.toContain("database-runtime:");
    expect(checksWorkflow).not.toContain("container-image:");
    expect(checksWorkflow).toContain("Web browser and accessibility checks");
  });

  it("reuses browser downloads without restoring stale dependency caches", () => {
    const browserJob = checksWorkflow.slice(
      checksWorkflow.indexOf("\n  browser:\n"),
      checksWorkflow.indexOf("\n  security-secrets:\n")
    );

    expect(browserJob).toContain("~/.cache/ms-playwright");
    expect(browserJob.indexOf("actions/cache@")).toBeLessThan(
      browserJob.indexOf("playwright install --with-deps chromium")
    );
    expect(bunInstallAction).not.toContain("restore-keys:");
  });

  it("keeps the merge gate unconditional and checks skipped jobs against a successful plan", () => {
    const requiredJob = checksWorkflow.slice(checksWorkflow.indexOf("\n  required-checks:\n"));
    expect(requiredJob).toContain("name: Required Checks");
    expect(requiredJob).toContain("- changes");
    expect(requiredJob).toContain("if: ${{ always() }}");
    expect(requiredJob).toContain("run: bash scripts/check-ci-results.sh");
    expect(checksWorkflow).toContain("fetch-depth: 0");
    expect(checksWorkflow).toContain("run: bun scripts/ci-changes.ts");
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
    for (const action of externalActions) expect(action[2]).toMatch(/^[0-9a-f]{40}$/u);
  });
});
