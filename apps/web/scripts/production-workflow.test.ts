import { describe, expect, it } from "vitest";

const repositoryRoot = `${process.cwd()}/../..`;
const workflow = await Bun.file(`${repositoryRoot}/.github/workflows/production.yml`).text();
const manualRollback = await Bun.file(
  `${repositoryRoot}/.github/workflows/production-rollback.yml`
).text();
const profileAction = await Bun.file(
  `${repositoryRoot}/.github/actions/configure-alchemy-cloudflare-profile/action.yml`
).text();
const bootstrapAction = await Bun.file(
  `${repositoryRoot}/.github/actions/bootstrap-alchemy-cloudflare-state/action.yml`
).text();

describe("Production release workflow policy", () => {
  it("limits the direct smoke bootstrap to an explicit protected dispatch", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain(
      "BOOTSTRAP_RELEASE: ${{ github.event_name == 'workflow_dispatch' && inputs.bootstrap }}"
    );
    const legacyCapture = workflow.indexOf("bun production-release.ts bootstrap-capture");
    const upload = workflow.indexOf("alchemy deploy --stage production --yes --no-input");
    const smoke = workflow.indexOf("bun production-release.ts bootstrap-verify");
    expect(legacyCapture).toBeGreaterThan(0);
    expect(legacyCapture).toBeLessThan(upload);
    expect(smoke).toBeGreaterThan(upload);
    expect(workflow).toContain("if: ${{ env.BOOTSTRAP_RELEASE != 'true' }}");
    expect(workflow).toContain("if: ${{ env.BOOTSTRAP_RELEASE == 'true' }}");
  });
  it("requires protected stable-pair capture before accepting only inspected Worker drift", () => {
    expect(workflow).toContain(
      "RESUME_RELEASE: ${{ github.event_name == 'workflow_dispatch' && inputs.resume && !inputs.bootstrap }}"
    );
    const resumeCapture = workflow.indexOf("bun production-release.ts resume-capture");
    const driftGate = workflow.indexOf("bash scripts/check-topology-drift.sh resume");
    const upload = workflow.indexOf("alchemy deploy --stage production --yes --no-input");
    expect(resumeCapture).toBeGreaterThan(0);
    expect(resumeCapture).toBeLessThan(driftGate);
    expect(driftGate).toBeLessThan(upload);
    expect(workflow).toContain("bash scripts/check-topology-drift.sh\n");
  });
  it("serializes trunk releases without cancelling an active deployment", () => {
    expect(workflow).toContain("branches: [trunk]");
    expect(workflow).toContain("group: production-deployment");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
  });

  it("initializes runner-local release files in a step before capture", () => {
    const jobEnv = workflow.slice(workflow.indexOf("    env:\n"), workflow.indexOf("    steps:\n"));
    const paths = workflow.indexOf("- name: Configure release file paths");
    const capture = workflow.indexOf("- name: Capture stable Worker deployments");

    expect(jobEnv).not.toContain("${{ runner.");
    expect(paths).toBeGreaterThan(0);
    expect(paths).toBeLessThan(capture);
    expect(workflow).toContain(
      'echo "RELEASE_SNAPSHOT_FILE=$RUNNER_TEMP/fidy-release.json" >> "$GITHUB_ENV"'
    );
    expect(workflow).toContain(
      'echo "SMOKE_ATTESTATION_FILE=$RUNNER_TEMP/fidy-smoke-passed.json" >> "$GITHUB_ENV"'
    );
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
    expect(profileAction).toContain('echo "ALCHEMY_HOME=$RUNNER_TEMP/alchemy" >> "$GITHUB_ENV"');
    expect(workflow).toContain(
      "ALCHEMY_PROFILE: ci\n      CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}\n      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}"
    );
    expect(profileAction).toContain("bunx alchemy profile create");
    expect(profileAction).toContain("bunx alchemy profile edit");
    expect(profileAction).toContain("apiToken=env:CLOUDFLARE_API_TOKEN");
    expect(profileAction).toContain("accountId=env:CLOUDFLARE_ACCOUNT_ID");
    expect(workflow).toContain("PAT_ADMISSION_KEY: ${{ secrets.PAT_ADMISSION_KEY }}");
  });

  it("provides complete production runtime config to Alchemy plan and deploy", () => {
    const planStart = workflow.indexOf("- name: Plan the complete Cloudflare topology");
    const trunkRecheck = workflow.indexOf("- name: Recheck trunk immediately before deployment");
    const deployStart = workflow.indexOf(
      "- name: Upload zero-traffic Worker candidates with Alchemy"
    );
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

  it("rejects migration and provider drift before planning and approves the non-interactive deploy", () => {
    const profile = workflow.indexOf(
      "uses: ./.github/actions/configure-alchemy-cloudflare-profile"
    );
    const migrationDriftGate = workflow.indexOf(
      "run: bun scripts/check-applied-migration-drift.ts"
    );
    const bootstrap = workflow.indexOf(
      "uses: ./.github/actions/bootstrap-alchemy-cloudflare-state"
    );
    const providerDriftGate = workflow.indexOf("bash scripts/check-topology-drift.sh");
    const plan = workflow.indexOf("alchemy plan");

    expect(profile).toBeGreaterThan(0);
    expect(workflow).toContain("name: Reject drift in applied D1 migration history");
    expect(migrationDriftGate).toBeGreaterThan(0);
    expect(profile).toBeLessThan(migrationDriftGate);
    expect(migrationDriftGate).toBeLessThan(bootstrap);
    expect(bootstrap).toBeLessThan(providerDriftGate);
    expect(providerDriftGate).toBeLessThan(plan);
    expect(bootstrapAction).toContain("alchemy provider cloudflare bootstrap");
    expect(workflow).toContain("alchemy deploy --stage production --yes --no-input");
  });

  it("requires the reviewed desired edge policy before planning", () => {
    const policyGate = workflow.indexOf("bun ./verify-edge-policy.ts");
    const plan = workflow.indexOf("alchemy plan --stage production --no-input");

    expect(policyGate).toBeGreaterThan(0);
    expect(policyGate).toBeLessThan(plan);
  });

  it("keeps Alchemy the topology authority and restricts the routing escape hatch", () => {
    const capture = workflow.indexOf("bun production-release.ts capture");
    const upload = workflow.indexOf("alchemy deploy --stage production --yes --no-input");
    const stage = workflow.indexOf("bun production-release.ts stage");
    const smoke = workflow.indexOf("bun verify-production-smoke.ts");
    const promotion = workflow.indexOf("bun production-release.ts promote");
    expect(capture).toBeGreaterThan(0);
    expect(capture).toBeLessThan(upload);
    expect(upload).toBeLessThan(stage);
    expect(stage).toBeLessThan(smoke);
    expect(smoke).toBeLessThan(promotion);
    expect(workflow).toContain("bun production-release.ts cleanup");
    expect(workflow).toContain("bun infra/cloudflare/production-release.ts report");
    expect(workflow).toContain("Observed Worker traffic:");
    expect(workflow).toContain("failure() && steps.capture.outcome == 'success'");
    expect(workflow).toContain("alchemy plan --stage production --no-input");
    expect(workflow).toContain("alchemy deploy --stage production --yes --no-input");
    expect(workflow).not.toContain("wrangler");
    expect(workflow).not.toContain("railway");
    expect(workflow).not.toContain("cloudflare/wrangler.json");
    expect(workflow).not.toContain("cloudflare/wrangler-action");
  });

  it("probes normal traffic before guarded rollback and alerts when release recovery fails", () => {
    const promote = workflow.indexOf("bun production-release.ts promote");
    const probe = workflow.indexOf("bun verify-production-smoke.ts promoted");
    const rollback = workflow.indexOf("bun production-release.ts rollback");
    const alert = workflow.indexOf("Email operator if deployment failed");
    expect(promote).toBeGreaterThan(0);
    expect(promote).toBeLessThan(probe);
    expect(probe).toBeLessThan(rollback);
    expect(rollback).toBeLessThan(alert);
    expect(workflow).toContain("steps.post_smoke.outcome == 'failure'");
    expect(workflow).toContain("steps.promote.outcome == 'success'");
    expect(manualRollback).toContain("workflow_dispatch:");
    expect(manualRollback).toContain("group: production-deployment");
    const receiptCheck = manualRollback.indexOf("bun infra/cloudflare/verify-rollback-receipt.ts");
    const manualWrite = manualRollback.indexOf("bun production-release.ts rollback");
    expect(receiptCheck).toBeGreaterThan(0);
    expect(receiptCheck).toBeLessThan(manualWrite);
  });

  it("verifies the public topology and provider state after deployment", () => {
    const deploy = workflow.indexOf("alchemy deploy");
    const verification = workflow.indexOf("Verify the migrated public topology");
    const postDeploymentDrift = workflow.indexOf("Reject post-deployment Cloudflare drift");
    const postDeploymentDriftCommand = workflow.indexOf(
      "bash scripts/check-topology-drift.sh",
      postDeploymentDrift
    );
    const releaseRecord = workflow.indexOf("Record the release");

    expect(deploy).toBeLessThan(verification);
    expect(verification).toBeLessThan(postDeploymentDrift);
    expect(postDeploymentDriftCommand).toBeGreaterThan(postDeploymentDrift);
    expect(postDeploymentDriftCommand).toBeLessThan(releaseRecord);
    expect(workflow.match(/bash scripts\/check-topology-drift\.sh/gu)).toHaveLength(3);
    expect(workflow).not.toContain("alchemy drift --stage production --no-input");
    expect(workflow).toContain("https://fidyapp.com/health-check");
    expect(workflow).toContain("https://app.fidyapp.com/deployment-metadata.json");
    expect(workflow).toContain("https://api.fidyapp.com/health");
    expect(workflow).toContain("$RELEASE_GIT_SHA");
    expect(workflow).toContain("$CONTRACT_DIGEST");
  });

  it("checks bounded, rejected machine requests only after the deployed topology is available", () => {
    const deploy = workflow.indexOf("alchemy deploy --stage production");
    const topology = workflow.indexOf("Verify the migrated public topology");
    const smoke = workflow.indexOf("bun ./verify-edge-smoke.ts");
    const record = workflow.indexOf("Record the release");

    expect(deploy).toBeLessThan(topology);
    expect(topology).toBeLessThan(smoke);
    expect(smoke).toBeLessThan(record);
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
