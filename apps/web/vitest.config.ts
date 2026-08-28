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
      include: [
        "src/app/**/*.{ts,tsx}",
        "src/features/**/*.{ts,tsx}",
        "src/session/**/*.{ts,tsx}",
        "src/transport/**/*.{ts,tsx}",
        "src/ui/**/*.{ts,tsx}",
      ],
      // Browser orchestration is exercised through its real timers, transport, clipboard, and DOM
      // in Playwright; Istanbul's jsdom unit runtime cannot represent those acceptance seams.
      exclude: [
        "src/testing/**",
        "src/ui/components/**",
        "src/features/browser-login/**",
        "src/features/dashboard/drag-adapter.tsx",
        "src/features/pats/feature.tsx",
      ],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
