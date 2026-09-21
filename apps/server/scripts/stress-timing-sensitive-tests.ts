#!/usr/bin/env bun

type StressScenario = Readonly<{ file: string; name: string }>;

const serverRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
const requestedRuns = Bun.env.SERVER_TIMING_STRESS_RUNS ?? "3";
const runs = Number.parseInt(requestedRuns, 10);

if (!/^\d+$/u.test(requestedRuns) || runs < 1 || runs > 100) {
  throw new Error("SERVER_TIMING_STRESS_RUNS must be an integer from 1 through 100");
}

const requestedFile = Bun.env.SERVER_TIMING_STRESS_FILE;
const requestedName = Bun.env.SERVER_TIMING_STRESS_NAME;
if ((requestedFile === undefined) !== (requestedName === undefined)) {
  throw new Error("SERVER_TIMING_STRESS_FILE and SERVER_TIMING_STRESS_NAME must be set together");
}

const defaultScenarios: ReadonlyArray<StressScenario> = [
  {
    file: "src/shell/subscription/billing-reconciliation.integration.test.ts",
    name: "survives runtime loss while waiting and settles without a duplicate period",
  },
  {
    file: "src/shell/agent/hosted-turns.integration.test.ts",
    name: "replacement recovers an admitted Turn without another message, inference, or delivery",
  },
  {
    file: "src/shell/email-authentication/pairing-workflow.integration.test.ts",
    name: "coordinates duplicate delivery across independently scoped SQL runtimes",
  },
  {
    file: "src/shell/email-authentication/replacement-workflow.integration.test.ts",
    name: "reconciles graceful runtime loss after provider acceptance without another send",
  },
  {
    file: "src/shell/ingestion/forwarded-email-workflow.integration.test.ts",
    name: "coordinates one idempotent workflow across independent runtimes",
  },
  {
    file: "src/shell/channels/whatsapp/disclosure-workflow.integration.test.ts",
    name: "resumes a persisted retry clock after restart without retrying before its deadline",
  },
  {
    file: "src/shell/onboarding/delivery-workflow.integration.test.ts",
    name: "coordinates one Activity across two independent runtimes",
  },
];
const scenarios: ReadonlyArray<StressScenario> =
  requestedFile === undefined || requestedName === undefined
    ? defaultScenarios
    : [{ file: requestedFile, name: requestedName }];

for (let run = 1; run <= runs; run += 1) {
  for (const scenario of scenarios) {
    await Bun.write(
      Bun.stdout,
      `Timing stress run ${run}/${runs}: ${scenario.file} > ${scenario.name}\n`
    );
    const child = Bun.spawn(
      [
        "bun",
        "--bun",
        "vitest",
        "run",
        "--config",
        "vitest.slow.config.ts",
        "--coverage.enabled=false",
        scenario.file,
        "-t",
        scenario.name,
      ],
      {
        cwd: serverRoot,
        env: Bun.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }
    );
    const exitCode = await child.exited;
    if (exitCode !== 0) process.exit(exitCode);
  }
}
