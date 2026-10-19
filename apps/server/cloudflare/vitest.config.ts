import { defineConfig } from "vitest/config";
import { CloudflareTestSequencer } from "./test-sequencer";

export default defineConfig({
  resolve: {
    alias: {
      "~": new URL("../src", import.meta.url).pathname,
      "cloudflare:workers": new URL("./workflow-test-runtime.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["cloudflare/**/*.test.ts"],
    sequence: { sequencer: CloudflareTestSequencer },
    pool: "forks",
    fileParallelism: true,
    maxWorkers: 8,
    testTimeout: 15_000,
    silent: "passed-only",
  },
});
