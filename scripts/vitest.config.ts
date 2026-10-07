import { defineConfig } from "vitest/config";

export default defineConfig({
  // The public server API's transitive imports use its application-local alias.
  resolve: { alias: { "~": new URL("../apps/server/src", import.meta.url).pathname } },
  test: { include: ["scripts/**/*.test.ts"], environment: "node", testTimeout: 15_000 },
});
