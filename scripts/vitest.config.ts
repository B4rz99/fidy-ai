import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "~": new URL("../apps/server/src", import.meta.url).pathname } },
  test: { include: ["scripts/**/*.test.ts"], environment: "node", testTimeout: 15_000 },
});
