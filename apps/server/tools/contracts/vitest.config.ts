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
    environment: "node",
    pool: "forks",
  },
});
