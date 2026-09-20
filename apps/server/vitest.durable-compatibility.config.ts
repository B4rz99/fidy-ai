import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The durable compatibility suite only decodes checked-in fixture bytes with production schemas.
// It never opens a database, so it runs without the main config's schema-dropping global setup.
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/shell/testing/durable-compatibility/*.compatibility.test.ts"],
    // Isolate mock call history explicitly rather than relying on Vitest 5's default.
    clearMocks: true,
    // Vitest 5's failure for unawaited asynchronous assertions is deliberate.
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
