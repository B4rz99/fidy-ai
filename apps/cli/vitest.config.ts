import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "~": new URL("../server/src", import.meta.url).pathname } },
  test: { include: ["src/**/*.test.ts"] },
});
