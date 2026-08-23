import { defineConfig } from "@playwright/test";

/** Browser checks intentionally exercise the built static shell, not a development server. */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 2,
  reporter: "line",
  use: {
    baseURL: "https://127.0.0.1:4173",
    ignoreHTTPSErrors: true,
    launchOptions: { args: ["--ignore-certificate-errors"] },
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command:
      "VITE_API_ORIGIN=https://127.0.0.1:4174 bun --bun vite build --mode production --outDir playwright-dist && cd ../server && DATABASE_URL=${DATABASE_URL:-postgres://fidy_runtime:fidy_runtime@127.0.0.1:5433/fidy} MIGRATION_DATABASE_URL=${MIGRATION_DATABASE_URL:-postgres://fidy:fidy@127.0.0.1:5433/fidy} bun scripts/run-browser-pairing-acceptance-server.ts",
    url: "https://127.0.0.1:4174/health",
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
