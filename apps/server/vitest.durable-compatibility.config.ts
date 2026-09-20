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
    // Preserve Vitest 5's isolated mock history and awaited asynchronous assertion semantics.
    clearMocks: true,
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
