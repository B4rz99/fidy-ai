import { configDefaults, defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

const nativeFileMilliseconds: ReadonlyMap<string, number> = new Map(
  Object.entries({
    "local-emulation.test.ts": 15_300,
    "openai-conformance-script.test.ts": 14_800,
    "release-controller.test.ts": 13_200,
    "diagnose-smoke-routing.test.ts": 7_600,
  })
);

const nativeProcessTests = [
  "local-emulation.test.ts",
  "openai-conformance-script.test.ts",
  "smoke-schema.test.ts",
  "workers.test.ts",
];

class InfrastructureTestSequencer extends BaseSequencer {
  override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const cost = (file: TestSpecification): number =>
      nativeFileMilliseconds.get(file.moduleId.split("/").at(-1) ?? "") ?? 0;

    return super
      .sort(files)
      .then((ordered) => ordered.sort((left, right) => cost(right) - cost(left)));
  }
}

export default defineConfig({
  test: {
    maxConcurrency: 2,
    sequence: { sequencer: InfrastructureTestSequencer },
    projects: [
      {
        extends: true,
        test: {
          name: "infrastructure",
          exclude: [...configDefaults.exclude, ...nativeProcessTests],
        },
      },
      {
        extends: true,
        test: { name: "native-process", include: nativeProcessTests, testTimeout: 30_000 },
      },
    ],
  },
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
