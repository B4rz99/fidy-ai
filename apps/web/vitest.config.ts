import { defineConfig } from "vitest/config";
import { serverClientBoundary } from "./server-client-boundary.ts";

export default defineConfig({
  plugins: [serverClientBoundary()],
  resolve: {
    alias: {
      "@": Bun.fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    // Bound concurrent DOM runtimes and browser-discovery subprocesses on local and CI hosts.
    maxWorkers: 2,
    // Isolate rendered-behavior mock history explicitly rather than relying on Vitest 5's default.
    clearMocks: true,
    // Vitest 5's failure for unawaited asynchronous assertions is deliberate: assertion failures
    // must remain attached to their owning test.
    include: ["src/**/*.test.ts", "cloudflare/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["./src/testing/setup.ts"],
    coverage: {
      provider: "istanbul",
      reportsDirectory: "coverage",
      reporter: ["text", "json-summary", "html"],
      // Vitest 5 matches these paths from the apps/web project root, not the workspace root.
      include: [
        "src/app/**/*.ts",
        "src/features/**/*.ts",
        "src/session/**/*.ts",
        "src/transport/**/*.ts",
        "src/ui/**/*.ts",
      ],
      // Browser orchestration is exercised through its real timers, transport, clipboard, and DOM
      // in Playwright; Istanbul's jsdom unit runtime cannot represent those acceptance seams.
      exclude: [
        "src/testing/**",
        "src/features/browser-login/**",
        "src/features/provider-authentication/**",
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
