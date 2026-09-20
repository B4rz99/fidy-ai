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
    // Preserve Vitest 5's isolated mock history and awaited asynchronous assertion semantics.
    clearMocks: true,
    environment: "node",
    pool: "forks",
  },
});
