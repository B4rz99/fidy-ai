import { CORE_SRC } from "./source-scope.mjs";

export default {
  testRunner: "command",
  commandRunner: {
    command:
      "bun --bun vitest run --config vitest.core.config.ts --coverage.enabled=false --maxWorkers=2",
  },
  concurrency: 1,
  mutate: CORE_SRC.flatMap((sourceDir) => [`${sourceDir}/**/*.ts`, `!${sourceDir}/**/*.test.ts`]),
  coverageAnalysis: "off",
  mutator: {
    excludedMutations: ["StringLiteral", "ObjectLiteral"],
  },
  thresholds: { high: 100, low: 100, break: 100 },
  reporters: ["clear-text", "html", "progress"],
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  tempDirName: ".stryker-tmp",
  ignorePatterns: [
    "**",
    "!/src/core/**",
    "!/package.json",
    "!/tsconfig.json",
    "!/bunfig.toml",
    "!/vitest.core.config.ts",
    "!/source-scope.mjs",
  ],
};
