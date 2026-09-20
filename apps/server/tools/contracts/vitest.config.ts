import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("../../src", import.meta.url)),
    },
  },
  test: {
    include: ["tools/contracts/**/*.test.ts"],
    // Isolate mock call history explicitly rather than relying on Vitest 5's default.
    clearMocks: true,
    // Vitest 5's failure for unawaited asynchronous assertions is deliberate.
    environment: "node",
    pool: "forks",
  },
});
