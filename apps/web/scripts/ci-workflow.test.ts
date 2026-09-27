import { describe, expect, it } from "vitest";

const repositoryRoot = `${process.cwd()}/../..`;
const checksWorkflow = await Bun.file(`${repositoryRoot}/.github/workflows/ci.yml`).text();
const bunInstallAction = await Bun.file(
  `${repositoryRoot}/.github/actions/bun-install/action.yml`
).text();

describe("pull-request checks workflow policy", () => {
  it("builds the application without uploading or deploying a PR preview artifact", () => {
    const buildsJob = checksWorkflow.slice(
      checksWorkflow.indexOf("  builds:"),
      checksWorkflow.indexOf("  unit:")
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
      checksWorkflow.indexOf("  browser:"),
      checksWorkflow.indexOf("  security-secrets:")
    );

    expect(browserJob).toContain("~/.cache/ms-playwright");
    expect(browserJob.indexOf("actions/cache@")).toBeLessThan(
      browserJob.indexOf("playwright install --with-deps chromium")
    );
    expect(bunInstallAction).not.toContain("restore-keys:");
  });

  it("pins every external Action to a complete commit SHA", () => {
    const externalActions = Array.from(
      checksWorkflow.matchAll(/^\s+(?:- )?uses: ([^./][^@\s]+)@([^\s#]+)/gmu)
    );

    expect(externalActions.length).toBeGreaterThan(0);
    for (const action of externalActions) expect(action[2]).toMatch(/^[0-9a-f]{40}$/u);
  });
});
