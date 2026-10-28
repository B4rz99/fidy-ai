import type { Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";
import { Config, Effect, Schema } from "effect";

type Observation = Readonly<{
  file: string;
  title: string;
  status: string;
  milliseconds: number;
  actions: ReadonlyArray<Readonly<{ operation: string; milliseconds: number; failed: boolean }>>;
}>;
const output = Effect.runSync(
  Config.String("FIDY_PERFORMANCE_OUTPUT").pipe(
    Config.withDefault("../../reports/performance/full-suite.json")
  )
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Records runner timings separately from browser readiness and native service measurements. */
export default class PerformanceReporter implements Reporter {
  private readonly observations: Observation[] = [];
  private readonly actions = new Map<string, Observation["actions"][number][]>();

  onTestBegin(test: TestCase): void {
    this.actions.set(test.id, []);
  }

  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    if (step.category !== "pw:api" && step.category !== "expect") return;
    this.actions.get(test.id)?.push({
      operation: step.category === "expect" ? "assertion" : (step.title.split(" ")[0] ?? "action"),
      milliseconds: step.duration,
      failed: step.error !== undefined,
    });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.observations.push({
      file: test.location.file.split("/e2e/")[1] ?? "unknown",
      title: test.title,
      status: result.status,
      milliseconds: result.duration,
      actions: this.actions.get(test.id) ?? [],
    });
    this.actions.delete(test.id);
  }

  onEnd(): Promise<void> {
    return Bun.write(
      output,
      encode({
        metric:
          "Playwright wall-clock diagnostics; includes setup, assertions and test-controlled delays",
        observations: this.observations,
      })
    ).then(() => undefined);
  }
}
