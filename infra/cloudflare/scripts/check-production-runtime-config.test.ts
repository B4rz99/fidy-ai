import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./check-production-runtime-config.sh", import.meta.url));
const workingDirectory = fileURLToPath(new URL("../", import.meta.url));
const productionWorkflowPath = fileURLToPath(
  new URL("../../../.github/workflows/production.yml", import.meta.url)
);
const testValue = "runtime-config-test-value";

const workflowStep = async (stepName: string): Promise<string> => {
  const workflow = await readFile(productionWorkflowPath, "utf8");
  const stepStart = workflow.indexOf(`      - name: ${stepName}\n`);
  if (stepStart < 0) return "";

  const stepEnd = workflow.indexOf("\n      - name:", stepStart + 1);
  return workflow.slice(stepStart, stepEnd < 0 ? undefined : stepEnd);
};
const requiredConfiguration = [
  "PAT_ADMISSION_KEY",
  "KAPSO_API_KEY",
  "KAPSO_WEBHOOK_SECRET",
  "WHATSAPP_BUSINESS_PORTFOLIO_ID",
  "RESEND_API_KEY",
  "WOMPI_ENVIRONMENT",
  "WOMPI_PUBLIC_KEY",
  "WOMPI_PRIVATE_KEY",
  "WOMPI_INTEGRITY_SECRET",
  "WOMPI_EVENT_SECRET",
  "CLOUDFLARE_ACCESS_ISSUER",
  "CLOUDFLARE_ACCESS_AUDIENCE",
] as const;

type ConfigurationName = (typeof requiredConfiguration)[number];

const runConfigurationGate = (
  missing?: ConfigurationName
): { readonly exitCode: number; readonly output: string } => {
  const env = { ...process.env };
  for (const name of requiredConfiguration) env[name] = testValue;
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
  it("accepts a complete runtime configuration without printing values", () => {
    const result = runConfigurationGate();

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Production runtime configuration is present.");
    expect(result.output).not.toContain(testValue);
  });

  it("rejects missing configuration with only a closed category", () => {
    const result = runConfigurationGate("KAPSO_API_KEY");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "check=production_runtime_configuration category=required_configuration_missing"
    );
    expect(result.output).not.toContain("KAPSO_API_KEY");
    expect(result.output).not.toContain(testValue);
  });

  it("rejects a missing PAT admission key without disclosing its name", () => {
    const result = runConfigurationGate("PAT_ADMISSION_KEY");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "check=production_runtime_configuration category=required_configuration_missing"
    );
    expect(result.output).not.toContain("PAT_ADMISSION_KEY");
    expect(result.output).not.toContain(testValue);
  });

  it("passes the Wompi event secret to both Production planning and deployment", async () => {
    const mapping = "WOMPI_EVENT_SECRET: ${{ secrets.WOMPI_EVENT_SECRET }}";
    const planning = await workflowStep("Plan the complete Cloudflare topology");
    const deployment = await workflowStep("Deploy the exact planned topology with Alchemy");

    expect(planning).toContain(mapping);
    expect(deployment).toContain(mapping);
  });

  it("rejects whitespace-only configuration", () => {
    const whitespaceEnv = { ...process.env };
    for (const name of requiredConfiguration) whitespaceEnv[name] = testValue;
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
