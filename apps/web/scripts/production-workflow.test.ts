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

  it("builds exact release metadata before planning the Alchemy topology", () => {
    const metadata = workflow.indexOf("CONTRACT_DIGEST=");
    const webBuild = workflow.indexOf("build:production");
    const plan = workflow.indexOf("alchemy plan");

    expect(workflow).toContain("RELEASE_GIT_SHA: ${{ github.sha }}");
    expect(metadata).toBeGreaterThan(0);
    expect(metadata).toBeLessThan(webBuild);
    expect(webBuild).toBeLessThan(plan);
  });

  it("keeps the CI Alchemy profile ephemeral and environment-backed", () => {
    expect(workflow).toContain('echo "ALCHEMY_HOME=$RUNNER_TEMP/alchemy" >> "$GITHUB_ENV"');
    expect(workflow).toContain(
      "ALCHEMY_PROFILE: ci\n      CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}\n      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}"
    );
    expect(workflow).toContain("apiToken=env:CLOUDFLARE_API_TOKEN");
    expect(workflow).toContain("accountId=env:CLOUDFLARE_ACCOUNT_ID");
  });

  it("runs the deterministic Worker boundary suite before deployment", () => {
    expect(workflow).toContain("bun run --cwd infra/cloudflare test -- workers.test.ts");
  });

  it("rejects provider drift before planning and approves the non-interactive deploy", () => {
    const profile = workflow.indexOf("alchemy profile edit");
    const bootstrap = workflow.indexOf("alchemy provider cloudflare bootstrap");
    const drift = workflow.indexOf("alchemy drift --stage production --no-input");
    const driftGate = workflow.indexOf('grep --fixed-strings --quiet "Plan: no changes"');
    const plan = workflow.indexOf("alchemy plan");

    expect(profile).toBeLessThan(bootstrap);
    expect(bootstrap).toBeLessThan(drift);
    expect(drift).toBeLessThan(driftGate);
    expect(driftGate).toBeLessThan(plan);
    expect(workflow).toContain("alchemy deploy --stage production --yes --no-input");
  });

  it("requires the reviewed desired edge policy before planning", () => {
    const policyGate = workflow.indexOf("bun ./verify-edge-policy.ts");
    const plan = workflow.indexOf("alchemy plan --stage production --no-input");

    expect(policyGate).toBeGreaterThan(0);
    expect(policyGate).toBeLessThan(plan);
  });

  it("makes Alchemy the only Cloudflare deployment authority", () => {
    expect(workflow).toContain("alchemy plan --stage production --no-input");
    expect(workflow).toContain("alchemy deploy --stage production --yes --no-input");
    expect(workflow).not.toContain("wrangler");
    expect(workflow).not.toContain("railway");
    expect(workflow).not.toContain("cloudflare/wrangler.json");
    expect(workflow).not.toContain("cloudflare/wrangler-action");
  });

  it("verifies the public topology and provider state after deployment", () => {
    const deploy = workflow.indexOf("alchemy deploy");
    const verification = workflow.indexOf("Verify the migrated public topology");
    const postDeploymentDrift = workflow.indexOf("Reject post-deployment Cloudflare drift");
    const releaseRecord = workflow.indexOf("Record the release");

    expect(deploy).toBeLessThan(verification);
    expect(verification).toBeLessThan(postDeploymentDrift);
    expect(postDeploymentDrift).toBeLessThan(releaseRecord);
    expect(workflow.match(/alchemy drift --stage production --no-input/gu)).toHaveLength(2);
    expect(workflow).toContain("https://fidyapp.com/health-check");
    expect(workflow).toContain("https://app.fidyapp.com/deployment-metadata.json");
    expect(workflow).toContain("https://api.fidyapp.com/health");
    expect(workflow).toContain("$RELEASE_GIT_SHA");
    expect(workflow).toContain("$CONTRACT_DIGEST");
  });

  it("rechecks trunk immediately before the Alchemy deployment", () => {
    const plan = workflow.indexOf("alchemy plan");
    const recheck = workflow.indexOf("Recheck trunk immediately before deployment");
    const deploy = workflow.indexOf("alchemy deploy");

    expect(plan).toBeLessThan(recheck);
    expect(recheck).toBeLessThan(deploy);
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
