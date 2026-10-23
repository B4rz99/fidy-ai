import { CORE_SRC } from "./source-scope.mjs";

export default {
  plugins: [
    "../../tools/mutation/node_modules/@stryker-mutator/vitest-runner/dist/src/index.js",
    "../../tools/mutation/equivalents.mjs",
  ],
  ignorers: ["exact-equivalents"],
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts" },
  concurrency: 4,
  mutate: CORE_SRC.flatMap((sourceDir) => [`${sourceDir}/**/*.ts`, `!${sourceDir}/**/*.test.ts`]),
  coverageAnalysis: "perTest",
  mutator: {
    excludedMutations: ["StringLiteral", "ObjectLiteral"],
  },
  thresholds: { high: 100, low: 100, break: 100 },
  reporters: ["clear-text", "html", "json", "progress"],
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  tempDirName: ".stryker-tmp",
  ignorePatterns: [
    "**",
    "!/src/core/**",
    "!/package.json",
    "!/tsconfig.json",
    "!/bunfig.toml",
    "!/vitest.core.config.ts",
    "!/vitest.mutation.config.ts",
    "!/source-scope.mjs",
  ],
};
