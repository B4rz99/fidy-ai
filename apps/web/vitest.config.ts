import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { serverClientBoundary } from "./server-client-boundary.ts";

export default defineConfig({
  plugins: [serverClientBoundary(), react()],
  resolve: {
    alias: {
      "@": Bun.fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    clearMocks: true,
    maxWorkers: 4,
    include: ["src/**/*.test.ts", "cloudflare/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      reportsDirectory: "coverage",
      reporter: ["text", "json-summary", "html"],
      include: ["src/browser/**/*.ts", "src/features/**/*.ts", "src/transport/**/*.ts"],
      exclude: ["src/features/browser-login/**", "src/features/provider-authentication/**"],
      thresholds: {
        "src/transport/**/*.ts": {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
      },
    },
  },
});
