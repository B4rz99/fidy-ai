import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Isolates deterministic email interpretation from database-backed shell setup and coverage. */
export default defineConfig({
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/shell/ingestion/email-interpretation/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    coverage: { enabled: false },
  },
});
