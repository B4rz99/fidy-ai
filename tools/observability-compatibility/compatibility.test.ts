import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CompatibilityReport,
  type CompatibilityTransportOutcome,
  compatibilityConditionNames,
} from "./handoff";

const rateLimitedConditionNames = [
  "runtimePinned",
  "onePreloadedClient",
  "applicationOutcome",
  "sdkPinned",
] as const satisfies ReadonlyArray<(typeof compatibilityConditionNames)[number]>;

const runFixture = async (input: {
  readonly transport: CompatibilityTransportOutcome;
  readonly processOutcome: "normal" | "failing";
}): Promise<Readonly<{ exitCode: number; report: CompatibilityReport; stderr: string }>> => {
  const child = Bun.spawn(
    [
      "bun",
      "--preload",
      "./tools/observability-compatibility/preload.ts",
      "./tools/observability-compatibility/fixture-process.test.ts",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FIDY_COMPATIBILITY_TRANSPORT: input.transport,
        FIDY_COMPATIBILITY_PROCESS_OUTCOME: input.processOutcome,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timeout = setTimeout(() => child.kill(), 15_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  const reportLine = stdout
    .split("\n")
    .find((line) => line.startsWith("FIDY_COMPATIBILITY_REPORT="));
  if (reportLine === undefined) {
    throw new Error(`compatibility fixture emitted no report\n${stderr}`);
  }
  const report = Schema.decodeUnknownSync(Schema.fromJsonString(CompatibilityReport))(
    reportLine.slice("FIDY_COMPATIBILITY_REPORT=".length)
  );
  return { exitCode, report, stderr };
};

const expectCompatibility = (
  report: CompatibilityReport,
  transport: CompatibilityTransportOutcome
): void => {
  // A 429 deliberately makes the SDK suppress later envelopes in this process. The compatibility
  // contract in that mode is application preservation, bounded shutdown, and the original client;
  // complete serialized-shape assertions belong to the accepted and failed transport runs.
  const conditions =
    transport === "rate-limited" ? rateLimitedConditionNames : compatibilityConditionNames;
  const failedConditions = conditions.filter((name) => report[name] !== true);
  expect(
    failedConditions,
    `failed compatibility conditions: ${failedConditions.join(", ")}`
  ).toEqual([]);
  expect(report.elapsedMilliseconds).toBeLessThan(10_000);
};

describe("the runtime remains compatible with pinned Bun, Effect, and Sentry", () => {
  it.each(["accepted", "rate-limited", "failed"] as const)(
    "preserves HTTP and Effect outcomes when the SDK transport is %s",
    async (transport) => {
      const result = await runFixture({ transport, processOutcome: "normal" });

      expect(result.exitCode, result.stderr).toBe(0);
      expectCompatibility(result.report, transport);
    },
    20_000
  );

  it("bounds telemetry flush before a failing process terminates", async () => {
    const result = await runFixture({ transport: "accepted", processOutcome: "failing" });

    expect(result.exitCode, result.stderr).toBe(23);
    expectCompatibility(result.report, "accepted");
  }, 20_000);
});
