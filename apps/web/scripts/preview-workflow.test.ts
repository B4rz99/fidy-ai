import { describe, expect, it } from "vitest";

const repositoryRoot = `${process.cwd()}/../..`;
const checksWorkflow = await Bun.file(`${repositoryRoot}/.github/workflows/ci.yml`).text();
const previewWorkflow = await Bun.file(`${repositoryRoot}/.github/workflows/preview.yml`).text();
const bunInstallAction = await Bun.file(
  `${repositoryRoot}/.github/actions/bun-install/action.yml`
).text();

describe("pull-request preview workflow policy", () => {
  it("builds the credential-free artifact alongside required checks for same-repository pull requests", () => {
    const buildsJob = checksWorkflow.slice(
      checksWorkflow.indexOf("  builds:"),
      checksWorkflow.indexOf("  unit:")
    );

    expect(buildsJob).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository"
    );
    expect(buildsJob).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(buildsJob).toContain("persist-credentials: false");
    expect(buildsJob).toContain("PREVIEW_GIT_SHA: ${{ github.event.pull_request.head.sha }}");
    const exactSourceBuild = buildsJob.slice(
      buildsJob.indexOf("Check out the exact preview source without credentials")
    );
    expect(exactSourceBuild).toContain("uses: ./.github/actions/bun-install");
    expect(exactSourceBuild.indexOf("uses: ./.github/actions/bun-install")).toBeLessThan(
      exactSourceBuild.indexOf("bun run --cwd apps/web build:preview")
    );
    expect(checksWorkflow).not.toContain("preview-artifact:");
  });

  it("shards server validation and aggregates its coverage once", () => {
    const serverJob = checksWorkflow.slice(
      checksWorkflow.indexOf("  server:"),
      checksWorkflow.indexOf("  quality:")
    );
    const qualityJob = checksWorkflow.slice(
      checksWorkflow.indexOf("  quality:"),
      checksWorkflow.indexOf("  production-image:")
    );

    expect(serverJob).toContain("matrix:");
    expect(serverJob).toContain("shard: [1, 2, 3]");
    expect(serverJob).toContain("SERVER_TEST_SHARD");
    expect(serverJob).toContain("server-coverage-${{ matrix.shard }}");
    expect(qualityJob).toContain("needs: server");
    expect(qualityJob).toContain("actions/download-artifact@");
    expect(qualityJob).toContain("services:");
    expect(qualityJob).toContain("Create restricted runtime role");
    expect(qualityJob).toContain("DATABASE_URL:");
    expect(qualityJob).toContain("bun run verify -- --group quality");
  });

  it("reuses browser downloads without restoring stale dependency caches", () => {
    const browserJob = checksWorkflow.slice(
      checksWorkflow.indexOf("  browser:"),
      checksWorkflow.indexOf("  server:")
    );

    expect(browserJob).toContain("~/.cache/ms-playwright");
    expect(browserJob.indexOf("actions/cache@")).toBeLessThan(
      browserJob.indexOf("playwright install --with-deps chromium")
    );
    expect(bunInstallAction).not.toContain("restore-keys:");
  });

  it("deploys from a trusted workflow only after independently checking identity and artifact policy", () => {
    expect(previewWorkflow).toContain("workflow_run:");
    expect(previewWorkflow).not.toContain("pull_request_target:");
    expect(previewWorkflow.match(/preview-policy\/request\.ts/gu)).toHaveLength(3);
    expect(previewWorkflow).toContain("preview-policy/artifact.ts");
    expect(previewWorkflow.indexOf("preview-policy/artifact.ts")).toBeLessThan(
      previewWorkflow.indexOf("cloudflare/wrangler-action@")
    );
    expect(previewWorkflow).not.toContain("wranglerVersion");
    expect(previewWorkflow.indexOf("bun install --frozen-lockfile")).toBeLessThan(
      previewWorkflow.indexOf("cloudflare/wrangler-action@")
    );
  });

  it("pins every external Action to a complete commit SHA", () => {
    const externalActions = Array.from(
      `${checksWorkflow}\n${previewWorkflow}`.matchAll(
        /^\s+(?:- )?uses: ([^./][^@\s]+)@([^\s#]+)/gmu
      )
    );

    expect(externalActions.length).toBeGreaterThan(0);
    for (const action of externalActions) expect(action[2]).toMatch(/^[0-9a-f]{40}$/u);
  });
});
