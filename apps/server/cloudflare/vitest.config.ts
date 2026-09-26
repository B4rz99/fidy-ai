import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "~": new URL("../src", import.meta.url).pathname,
      "cloudflare:workers": new URL("./workflow-test-runtime.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["cloudflare/**/*.test.ts"],
    // Miniflare instances answer their synchronous D1/R2 calls through a worker channel that
    // asserts each response id. Running several D1/R2-heavy files at once delivers a foreign id and
    // fails an unrelated file's test with `assert(message?.id === id)`. Files run one at a time so
    // the suite is deterministic; the complete suite still finishes in about a minute.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
