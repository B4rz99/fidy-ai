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
    // Bound concurrency on the existing runner, with a separate process and module isolation
    // for each file's native Miniflare channels. Do not share bindings or run concurrent cases.
    pool: "forks",
    fileParallelism: true,
    maxWorkers: 3,
    testTimeout: 15_000,
    // Retain console capture and reveal a failing case's logs without printing successful traffic.
    silent: "passed-only",
  },
});
