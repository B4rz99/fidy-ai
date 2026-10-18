import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// Start the native runtime and bounded subprocess suites before the small policy tests.
// Estimates are from successful fixed-runner CI 39163060495; ties keep Vitest's order.
const nativeFileMilliseconds: Readonly<Record<string, number>> = {
  "local-emulation.test.ts": 15_300,
  "workers-ai-conformance-script.test.ts": 14_800,
  "release-controller.test.ts": 13_200,
  "diagnose-smoke-routing.test.ts": 7_600,
  "d1-migrations.test.ts": 7_100,
};
class InfrastructureTestSequencer extends BaseSequencer {
  override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const cost = (file: TestSpecification): number =>
      nativeFileMilliseconds[file.moduleId.split("/").at(-1) ?? ""] ?? 0;
    return super
      .sort(files)
      .then((ordered) => ordered.sort((left, right) => cost(right) - cost(left)));
  }
}

export default defineConfig({
  test: { maxConcurrency: 2, sequence: { sequencer: InfrastructureTestSequencer } },
  resolve: {
    alias: {
      "~": new URL("../../apps/server/src", import.meta.url).pathname,
      "cloudflare:workers": new URL(
        "../../apps/server/cloudflare/workflow-test-runtime.ts",
        import.meta.url
      ).pathname,
    },
  },
});
