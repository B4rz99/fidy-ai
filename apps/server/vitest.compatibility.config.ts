import { defineConfig } from "vitest/config";

// This gate runs separately because every fixture process must start under the exact pinned Bun
// runtime with its own preload-owned native Sentry client.
export default defineConfig({
  test: {
    include: ["tools/observability-compatibility/compatibility.test.ts"],
    // Isolate mock call history explicitly rather than relying on Vitest 5's default.
    clearMocks: true,
    // Vitest 5's failure for unawaited asynchronous assertions is deliberate.
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
