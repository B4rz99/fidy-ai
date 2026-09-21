import { describe, expect, it } from "vitest";

const repositoryRoot = `${process.cwd()}/../..`;
const workflow = await Bun.file(`${repositoryRoot}/.github/workflows/production.yml`).text();

describe("Production release workflow policy", () => {
  it("serializes trunk releases without cancelling an active deployment", () => {
    expect(workflow).toContain("branches: [trunk]");
    expect(workflow).toContain("group: production-deployment");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
  });

  it("builds and validates the static artifact before uploading Cloudflare", () => {
    const webBuild = workflow.indexOf("build:production");
    const cloudflare = workflow.indexOf("versions upload");

    expect(workflow).not.toContain("Dockerfile");
    expect(workflow).not.toContain("docker ");
    expect(workflow).toContain("RELEASE_GIT_SHA: ${{ github.sha }}");
    expect(webBuild).toBeGreaterThan(0);
    expect(webBuild).toBeLessThan(cloudflare);
  });

  it("validates the static-only Wrangler adapter before uploading a version", () => {
    const webBuild = workflow.indexOf("build:production");
    const dryRun = workflow.indexOf("wrangler deploy --dry-run");
    const upload = workflow.indexOf("versions upload");

    expect(dryRun).toBeGreaterThan(webBuild);
    expect(dryRun).toBeLessThan(upload);
    expect(workflow).toContain("--config cloudflare/wrangler.json");
  });

  it("rechecks trunk and promotes only the exact uploaded Cloudflare version", () => {
    const upload = workflow.indexOf("versions upload");
    const parse = workflow.indexOf("scripts/production/cloudflare-version.ts");
    const recheck = workflow.indexOf("Recheck trunk immediately before promotion");
    const deploy = workflow.indexOf("versions deploy");

    expect(upload).toBeLessThan(parse);
    expect(parse).toBeLessThan(recheck);
    expect(recheck).toBeLessThan(deploy);
    expect(workflow).toContain("steps.cloudflare-version.outputs.version-id");
    expect(workflow).not.toContain("docker push");
  });

  it("pins every external Action to a complete commit SHA", () => {
    const externalActions = Array.from(
      workflow.matchAll(/^\s+(?:- )?uses: ([^./][^@\s]+)@([^\s#]+)/gmu)
    );

    expect(externalActions.length).toBeGreaterThan(0);
    for (const action of externalActions) expect(action[2]).toMatch(/^[0-9a-f]{40}$/u);
  });
});
