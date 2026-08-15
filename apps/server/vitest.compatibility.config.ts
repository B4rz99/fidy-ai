import { defineConfig } from "vitest/config";

// This gate runs separately because every fixture process must start under the exact pinned Bun
// runtime with its own preload-owned native Sentry client.
export default defineConfig({
  test: {
    include: ["tools/observability-compatibility/compatibility.test.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
