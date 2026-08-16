import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { serverClientBoundary } from "./server-client-boundary.ts";
import { WEB_BEHAVIOR_EXCLUDE, WEB_BEHAVIOR_SOURCE } from "./source-scope.ts";

export default defineConfig({
  plugins: [serverClientBoundary(), react()],
  resolve: {
    alias: {
      "@": Bun.fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "cloudflare/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    setupFiles: ["./src/testing/setup.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary", "html"],
      include: WEB_BEHAVIOR_SOURCE,
      exclude: WEB_BEHAVIOR_EXCLUDE,
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
