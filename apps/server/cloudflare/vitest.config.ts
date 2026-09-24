import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "~": new URL("../src", import.meta.url).pathname,
      "cloudflare:workers": new URL("./workflow-test-runtime.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["cloudflare/**/*.test.ts"],
  },
});
