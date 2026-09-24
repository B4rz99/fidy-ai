import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "~": new URL("../../apps/server/src", import.meta.url).pathname,
      "cloudflare:workers": new URL(
        "../../apps/server/cloudflare/workflow-test-runtime.ts",
        import.meta.url
      ).pathname,
    },
  },
});
