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
    expect(workflow).toContain("PAT_ADMISSION_KEY: ${{ secrets.PAT_ADMISSION_KEY }}");
  });

  it("provides complete production runtime config to Alchemy plan and deploy", () => {
    const planStart = workflow.indexOf("- name: Plan the complete Cloudflare topology");
    const trunkRecheck = workflow.indexOf("- name: Recheck trunk immediately before deployment");
    const deployStart = workflow.indexOf("- name: Deploy the exact planned topology with Alchemy");
    const verification = workflow.indexOf("- name: Verify the migrated public topology");
    const planStep = workflow.slice(planStart, trunkRecheck);
    const deployStep = workflow.slice(deployStart, verification);
    const runtimeConfiguration = [
      "KAPSO_API_KEY: ${{ secrets.KAPSO_API_KEY }}",
      "KAPSO_WEBHOOK_SECRET: ${{ secrets.KAPSO_WEBHOOK_SECRET }}",
      "WHATSAPP_BUSINESS_PORTFOLIO_ID: ${{ secrets.WHATSAPP_BUSINESS_PORTFOLIO_ID }}",
      "RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}",
      "WOMPI_ENVIRONMENT: ${{ secrets.WOMPI_ENVIRONMENT }}",
      "WOMPI_PUBLIC_KEY: ${{ secrets.WOMPI_PUBLIC_KEY }}",
      "WOMPI_PRIVATE_KEY: ${{ secrets.WOMPI_PRIVATE_KEY }}",
      "WOMPI_INTEGRITY_SECRET: ${{ secrets.WOMPI_INTEGRITY_SECRET }}",
      "CLOUDFLARE_ACCESS_ISSUER: ${{ secrets.CLOUDFLARE_ACCESS_ISSUER }}",
      "CLOUDFLARE_ACCESS_AUDIENCE: ${{ secrets.CLOUDFLARE_ACCESS_AUDIENCE }}",
    ];

    expect(planStart).toBeGreaterThan(0);
    expect(deployStart).toBeGreaterThan(0);
    for (const binding of runtimeConfiguration) {
      expect(planStep).toContain(binding);
      expect(deployStep).toContain(binding);
    }
    expect(planStep).toContain("bash scripts/check-production-runtime-config.sh");
    expect(deployStep).toContain("bash scripts/check-production-runtime-config.sh");
    expect(planStep.indexOf("bash scripts/check-production-runtime-config.sh")).toBeLessThan(
      planStep.indexOf("alchemy plan")
    );
    expect(deployStep.indexOf("bash scripts/check-production-runtime-config.sh")).toBeLessThan(
      deployStep.indexOf("alchemy deploy")
    );
  });

  it("runs the deterministic Worker boundary suite before deployment", () => {
    expect(workflow).toContain("bun run --cwd infra/cloudflare test -- workers.test.ts");
  });

  it("rejects provider drift before planning and approves the non-interactive deploy", () => {
    const profile = workflow.indexOf("alchemy profile edit");
    const bootstrap = workflow.indexOf("alchemy provider cloudflare bootstrap");
    const driftGate = workflow.indexOf("bash scripts/check-topology-drift.sh");
    const plan = workflow.indexOf("alchemy plan");

    expect(profile).toBeLessThan(bootstrap);
    expect(bootstrap).toBeLessThan(driftGate);
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
    const postDeploymentDriftCommand = workflow.indexOf(
      "alchemy drift --stage production --no-input"
    );
    const releaseRecord = workflow.indexOf("Record the release");

    expect(deploy).toBeLessThan(verification);
    expect(verification).toBeLessThan(postDeploymentDrift);
    expect(postDeploymentDrift).toBeLessThan(postDeploymentDriftCommand);
    expect(postDeploymentDriftCommand).toBeLessThan(releaseRecord);
    expect(workflow.match(/alchemy drift --stage production --no-input/gu)).toHaveLength(1);
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
