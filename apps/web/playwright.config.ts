import { defineConfig } from "@playwright/test";

const isCI = Boolean(process.env.CI);

/** Browser checks intentionally exercise the built static shell, not a development server. */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 2,
  reporter: isCI
    ? [["line"], ["json", { outputFile: "test-results/browser-timings.json" }]]
    : "line",
  use: {
    baseURL: "https://127.0.0.1:4173",
    ignoreHTTPSErrors: true,
    launchOptions: { args: ["--ignore-certificate-errors"] },
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command:
        "openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/fidy-playwright-key.pem -out /tmp/fidy-playwright-cert.pem -subj /CN=127.0.0.1 -days 1 >/dev/null 2>&1 && VITE_API_ORIGIN=https://127.0.0.1:4174 bun --bun vite build --mode production --outDir playwright-dist && PLAYWRIGHT_TLS_KEY=/tmp/fidy-playwright-key.pem PLAYWRIGHT_TLS_CERT=/tmp/fidy-playwright-cert.pem PREVIEW_ROOT=playwright-dist PREVIEW_PORT=4173 bun scripts/serve-preview.ts",
      url: "https://127.0.0.1:4173/",
      ignoreHTTPSErrors: true,
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command:
        "PLAYWRIGHT_TLS_KEY=/tmp/fidy-playwright-key.pem PLAYWRIGHT_TLS_CERT=/tmp/fidy-playwright-cert.pem bun ../server/cloudflare/browser-acceptance-preview.ts",
      url: "https://127.0.0.1:4174/health",
      ignoreHTTPSErrors: true,
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  ],
});
