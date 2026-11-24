/// <reference types="bun-types" />
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./check-production-runtime-config.sh", import.meta.url));

const workingDirectory = fileURLToPath(new URL("../", import.meta.url));

const productionWorkflowPath = fileURLToPath(
  new URL("../../../.github/workflows/native-storage-release.yml", import.meta.url)
);

const testValue = "runtime-config-test-value";

const smokeProof = "a".repeat(64);

const workflowStep = async (stepName: string): Promise<string> => {
  const workflow = await readFile(productionWorkflowPath, "utf8");
  const stepStart = workflow.indexOf(`      - name: ${stepName}\n`);

  if (stepStart < 0) return "";

  const stepEnd = workflow.indexOf("\n      - name:", stepStart + 1);

  return workflow.slice(stepStart, stepEnd < 0 ? undefined : stepEnd);
};

const requiredConfiguration = [
  "PAT_ADMISSION_KEY",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "OPENAI_API_KEY",
  "KAPSO_API_KEY",
  "KAPSO_WEBHOOK_SECRET",
  "WHATSAPP_BUSINESS_PORTFOLIO_ID",
  "RESEND_API_KEY",
  "OPERATOR_ALERT_EMAIL",
  "WOMPI_ENVIRONMENT",
  "WOMPI_PUBLIC_KEY",
  "WOMPI_PRIVATE_KEY",
  "WOMPI_INTEGRITY_SECRET",
  "WOMPI_EVENT_SECRET",
  "CLOUDFLARE_ACCESS_ISSUER",
  "RECOVERY_OPERATOR_EMAIL",
] as const;

type ConfigurationName = (typeof requiredConfiguration)[number];

type GateRun = { readonly exitCode: number; readonly output: string };

const runConfigurationGate = (missing?: ConfigurationName): GateRun => {
  const env = { ...process.env };

  for (const name of requiredConfiguration) env[name] = testValue;
  env.SMOKE_PROOF = smokeProof;

  if (missing !== undefined) env[missing] = "";

  const result = spawnSync("bash", [scriptPath], {
    cwd: workingDirectory,
    encoding: "utf8",
    env,
  });

  return {
    exitCode: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
  };
};

describe("Production runtime configuration gate", () => {
  it("rebuilds the retained Web output before signed planning and saves refused read-only evidence", async () => {
    const workflow = await readFile(productionWorkflowPath, "utf8");

    const build = await workflowStep(
      "Build the expected browser artifact for independent verification"
    );

    for (const operation of ["plan-fixture-repair", "resume-fixture-upload", "rollout"]) {
      expect(build).toContain(operation);
    }

    expect(build).toContain("env.FIXTURE_WEB_REVISION");
    expect(workflow.indexOf(build)).toBeLessThan(
      workflow.indexOf(
        await workflowStep("Read the complete dormant resource plan without applying it")
      )
    );
    expect(workflow.indexOf(build)).toBeLessThan(
      workflow.indexOf(await workflowStep("Upload the verified native candidates"))
    );
    const archive = await workflowStep("Save the observed read-only fallback inventory");
    expect(archive).toContain("always()");
    expect(archive).toContain("steps.dormant_plan.outcome == 'failure'");
  });
  it("accepts a complete runtime configuration without printing values", () => {
    const result = runConfigurationGate();

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Production runtime configuration is present.");
    expect(result.output).not.toContain(testValue);
  });

  it("rejects a malformed smoke proof without printing its value", () => {
    const env = { ...process.env, SMOKE_PROOF: "not-a-valid-proof" };

    for (const name of requiredConfiguration) env[name] = testValue;

    const result = spawnSync("bash", [scriptPath], {
      cwd: workingDirectory,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "check=production_runtime_configuration category=smoke_proof_invalid"
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("not-a-valid-proof");
  });

  it("rejects missing configuration with only a closed category", () => {
    for (const name of requiredConfiguration) {
      const result = runConfigurationGate(name);
      expect(result.exitCode, name).toBe(1);
      expect(result.output).toContain(
        "check=production_runtime_configuration category=required_configuration_missing"
      );
      expect(result.output).not.toContain(name);
      expect(result.output).not.toContain(testValue);
    }
  });

  it("passes the Production environment's configured Access issuer secret to the protected release", async () => {
    const workflow = await readFile(productionWorkflowPath, "utf8");
    expect(workflow).toContain("CLOUDFLARE_ACCESS_ISSUER: ${{ secrets.CLOUDFLARE_ACCESS_ISSUER }}");
  });

  it("runs the protected plan without starting installation or installed verification", async () => {
    const preview = await workflowStep(
      "Verify the fresh native plan against the existing state store"
    );

    const install = await workflowStep("Install the verified fresh native application");

    const verify = await workflowStep(
      "Verify the installed application and retained schema markers"
    );

    expect(preview).toContain("if: env.RELEASE_OPERATION == 'plan-first-install'");
    expect(preview).toContain("run: bun native-storage-resources.ts plan-first-install");
    expect(install).toContain("if: env.RELEASE_OPERATION == 'first-install'");
    expect(verify).toContain("env.RELEASE_OPERATION != 'plan-fixture-repair'");
    expect(verify).toContain(
      "if: env.RELEASE_OPERATION != 'plan-fixture-fallback' && env.RELEASE_OPERATION != 'plan-first-install' && env.RELEASE_OPERATION != 'first-install' && env.RELEASE_OPERATION != 'verify-erasure'"
    );
  });

  it("authenticates the interrupted upload before another candidate can be written", async () => {
    const source = await workflowStep(
      "Authenticate the original interrupted upload before planning or applying its repair"
    );

    for (const operation of ["plan-fixture-repair", "resume-fixture-upload"]) {
      expect(source).toContain(`env.RELEASE_OPERATION == '${operation}'`);
    }

    const planning = await workflowStep(
      "Read the complete dormant resource plan without applying it"
    );

    expect(planning).toContain("env.RELEASE_OPERATION == 'plan-fixture-repair'");
    expect(planning).not.toContain("resume-fixture-upload");

    const mutations = [
      "Upload the verified native candidates",
      "Stage the zero-traffic native candidates",
      "Seal dormant fallback stage before promotion",
      "Finish only the tested closed forward repair",
    ];

    for (const step of await Promise.all(mutations.map(workflowStep))) {
      expect(step).toContain("env.RELEASE_OPERATION == 'resume-fixture-upload'");
      expect(step).not.toContain("plan-fixture-repair");
    }

    const workflow = await readFile(productionWorkflowPath, "utf8");
    expect(workflow.indexOf(source)).toBeLessThan(
      workflow.indexOf(await workflowStep("Capture the native stable pair"))
    );
  });

  it("stages a pairing repair on its real source without promoting or changing hosts", async () => {
    const source = await workflowStep("Authenticate the predecessor of the pairing repair");
    expect(source).toContain("unsealed_stage.py replacement");

    for (const step of await Promise.all(
      [
        "Capture the native stable pair",
        "Upload the verified native candidates",
        "Stage the zero-traffic native candidates",
        "Qualify the closed recovery artifacts and their retained controls",
        "Seal dormant fallback stage before promotion",
      ].map(workflowStep)
    )) {
      expect(step).toContain("env.RELEASE_OPERATION == 'stage-pairing-repair'");
    }

    for (const step of await Promise.all(
      [
        "Bind the protected verifier to the staged application source",
        "Finish only the tested closed forward repair",
        "Verify mixed and candidate versions before promoting closed admission",
        "Stage only canonical Access paths and vacant hostnames on the verified closed release",
      ].map(workflowStep)
    )) {
      expect(step).not.toContain("stage-pairing-repair");
    }
  });

  it("restores the protected pairing upload before staging, checking controls and sealing at zero traffic", async () => {
    const workflow = await readFile(productionWorkflowPath, "utf8");
    let position = 0;

    for (const step of await Promise.all(
      [
        "Authenticate the interrupted pairing upload and its original controls",
        "Resume the exact uploaded Workers at zero traffic",
        "Persist and read back private observability on the installed application Workers",
        "Qualify the closed recovery artifacts and their retained controls",
        "Seal dormant fallback stage before promotion",
      ].map(workflowStep)
    )) {
      expect(step).toContain("env.RELEASE_OPERATION == 'resume-pairing-stage'");
      expect(workflow.indexOf(step)).toBeGreaterThan(position);
      position = workflow.indexOf(step);
    }

    for (const step of await Promise.all(
      [
        "Capture the native stable pair",
        "Upload the verified native candidates",
        "Stage the zero-traffic native candidates",
        "Finish only the tested closed forward repair",
        "Verify mixed and candidate versions before promoting closed admission",
        "Exercise the tested code-only rollback",
        "Stage only canonical Access paths and vacant hostnames on the verified closed release",
      ].map(workflowStep)
    )) {
      expect(step).not.toContain("env.RELEASE_OPERATION == 'resume-pairing-stage'");
    }
  });

  it("restricts resealing to archived pair verification and a GitHub evidence upload", async () => {
    const release = (await readFile(productionWorkflowPath, "utf8")).split("\n  site:")[0];

    const source = await workflowStep(
      "Bind the protected verifier to the staged application source"
    );

    const restore = await workflowStep("Authenticate the unsealed zero-traffic pair");

    const qualify = await workflowStep(
      "Requalify the archived zero-traffic pair without moving traffic"
    );

    const seal = await workflowStep("Seal dormant fallback stage before promotion");
    const steps = release.split("\n      - name: ").slice(1);

    const admitted = steps.filter((step) =>
      step
        .split("\n")
        .find((line) => line.startsWith("        if:"))
        ?.includes("env.RELEASE_OPERATION == 'reseal-fixture-fallback'")
    );

    expect(admitted.map((step) => step.split("\n")[0])).toEqual([
      "Bind the protected verifier to the staged application source",
      "Authenticate the unsealed zero-traffic pair",
      "Requalify the archived zero-traffic pair without moving traffic",
      "Seal dormant fallback stage before promotion",
    ]);

    const diagnosis = steps.filter((step) =>
      step
        .split("\n")
        .find((line) => line.startsWith("        if:"))
        ?.includes("env.RELEASE_OPERATION == 'diagnose-fixture-pairing'")
    );

    expect(diagnosis.map((step) => step.split("\n")[0])).toEqual([
      "Bind the protected verifier to the staged application source",
      "Authenticate the unsealed zero-traffic pair",
      "Compare pairing requests on the archived zero-traffic pair",
    ]);
    expect(diagnosis.at(-1)).toContain("bun native-storage-release.ts diagnose-pairing");
    expect(source).toContain("unsealed_stage.py source");
    expect(restore).toContain("unsealed_stage.py restore");
    expect(qualify).toContain("bun native-storage-release.ts reseal-fallback");
    expect(qualify).not.toContain("NATIVE_FIXTURE_SIGNING_KEY");
    expect(seal).toContain("if-no-files-found: error");

    const installed = await workflowStep(
      "Verify the installed application and retained schema markers"
    );

    expect(installed).toContain("env.RELEASE_OPERATION != 'reseal-fixture-fallback'");
    expect(installed).toContain("env.RELEASE_OPERATION != 'diagnose-fixture-pairing'");

    for (const step of steps.filter((item) => item.includes("run: bun native-storage-"))) {
      expect(step).toContain("        if:");
    }

    const recover = await workflowStep("Authenticate the interrupted dormant stage");
    expect(recover).toContain("if: env.RELEASE_OPERATION == 'recover-fixture-fallback'");
    expect(recover).toContain("fallback_stage.py");
    expect(release.indexOf(recover)).toBeLessThan(
      release.indexOf(await workflowStep("Finish only the tested closed forward repair"))
    );
  });

  it("keeps real payment secrets out of closed first installation", async () => {
    const first = await workflowStep("Install the verified fresh native application");
    expect(first).toContain("bun native-storage-resources.ts first-install");
    expect(first).not.toContain("secrets.WOMPI_EVENT_SECRET");
  });

  it("rejects whitespace-only configuration", () => {
    const whitespaceEnv = { ...process.env };

    for (const name of requiredConfiguration) whitespaceEnv[name] = testValue;
    whitespaceEnv.SMOKE_PROOF = smokeProof;
    whitespaceEnv.WOMPI_PUBLIC_KEY = " \t\n";

    const whitespaceResult = spawnSync("bash", [scriptPath], {
      cwd: workingDirectory,
      encoding: "utf8",
      env: whitespaceEnv,
    });

    expect(whitespaceResult.status).toBe(1);
    expect(`${whitespaceResult.stdout}${whitespaceResult.stderr}`).toContain(
      "check=production_runtime_configuration category=required_configuration_missing"
    );
    expect(`${whitespaceResult.stdout}${whitespaceResult.stderr}`).not.toContain(
      "WOMPI_PUBLIC_KEY"
    );
  });
});
