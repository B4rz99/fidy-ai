import { describe, expect, it } from "vitest";

const repositoryRoot = `${process.cwd()}/../..`;
const checksWorkflow = await Bun.file(`${repositoryRoot}/.github/workflows/ci.yml`).text();
const previewWorkflow = await Bun.file(`${repositoryRoot}/.github/workflows/preview.yml`).text();

describe("pull-request preview workflow policy", () => {
  it("builds the artifact without Secrets only after required checks for same-repository pull requests", () => {
    const previewJob = checksWorkflow.slice(checksWorkflow.indexOf("preview-artifact:"));

    expect(previewJob).toContain("needs: required-checks");
    expect(previewJob).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository"
    );
    expect(previewJob).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(previewJob).toContain("persist-credentials: false");
    expect(previewJob).toContain("PREVIEW_GIT_SHA: ${{ github.event.pull_request.head.sha }}");
  });

  it("deploys from a trusted workflow only after independently checking identity and artifact policy", () => {
    expect(previewWorkflow).toContain("workflow_run:");
    expect(previewWorkflow).not.toContain("pull_request_target:");
    expect(previewWorkflow.match(/preview-policy\/request\.ts/gu)).toHaveLength(3);
    expect(previewWorkflow).toContain("preview-policy/artifact.ts");
    expect(previewWorkflow.indexOf("preview-policy/artifact.ts")).toBeLessThan(
      previewWorkflow.indexOf("cloudflare/wrangler-action@")
    );
    expect(previewWorkflow).toContain('wranglerVersion: "4.123.0"');
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
