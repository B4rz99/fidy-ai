import { defineConfig } from "@playwright/test";

const isCI = Boolean(process.env.CI);
const measuringBrowserCost = process.env.BROWSER_COST_MEASUREMENT === "1";
const fixtureRuntime = measuringBrowserCost ? process.execPath : "bun";
const measurementAssertionMilliseconds = 30_000;
const normalAssertionMilliseconds = 5_000;
const browserWorkers = 12;
const performanceCases =
  /returns from .+ with its review form and original already available|returns to .+ from cached data while refreshing|switches between visited review tabs/u;
const performancePartitions: Readonly<Record<string, RegExp>> = {
  "1/2":
    /returns from .+ with its review form and original already available|returns to Transacciones from cached data while refreshing/u,
  "2/2":
    /returns to (Presupuestos|Recurrentes|Tablero) from cached data while refreshing|switches between visited review tabs/u,
};
const performanceSelection =
  performancePartitions[process.env.BROWSER_TEST_SHARD ?? ""] ?? performanceCases;
const normalStartupMilliseconds = 120_000;
const measurementStartupMilliseconds = 600_000;
const viteBuild = measuringBrowserCost
  ? `${fixtureRuntime} ../../node_modules/vite/bin/vite.js`
  : "bun --bun vite";

export default defineConfig({
  testDir: "./e2e",
  expect: {
    timeout: measuringBrowserCost ? measurementAssertionMilliseconds : normalAssertionMilliseconds,
  },
  projects: [
    {
      name: "admission",
      testMatch: ["acceptance-clock.spec.ts", "session-binding.spec.ts"],
      grep: /native admission|virtual waiting|rejects stale cross-tab drafts and logout/u,
      workers: 1,
    },
    {
      name: "performance",
      testMatch: ["needs-review.spec.ts", "workspace-navigation.spec.ts"],
      grep: performanceSelection,
      dependencies: ["admission"],
      workers: 1,
    },
    {
      name: "browser",
      testIgnore: ["cli-login.spec.ts", "acceptance-clock.spec.ts"],
      dependencies: ["performance"],
      grepInvert:
        /returns from .+ with its review form and original already available|returns to .+ from cached data while refreshing|switches between visited review tabs|rejects stale cross-tab drafts and logout/u,
    },
  ],
  fullyParallel: false,
  forbidOnly: isCI,
  retries: 0,
  workers: measuringBrowserCost ? 1 : browserWorkers,
  reporter: isCI
    ? [
        ["./scripts/browser-phase-reporter.ts"],
        ["line"],
        ["json", { outputFile: "test-results/browser-timings.json" }],
      ]
    : [["./scripts/browser-phase-reporter.ts"], ["line"]],
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
      command: `openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/fidy-playwright-key.pem -out /tmp/fidy-playwright-cert.pem -subj /CN=127.0.0.1 -days 1 >/dev/null 2>&1 && VITE_API_ORIGIN=https://127.0.0.1:4174 ${viteBuild} build --mode production --outDir playwright-dist && PLAYWRIGHT_TLS_KEY=/tmp/fidy-playwright-key.pem PLAYWRIGHT_TLS_CERT=/tmp/fidy-playwright-cert.pem PREVIEW_ROOT=playwright-dist PREVIEW_PORT=4173 ${fixtureRuntime} scripts/serve-preview.ts`,
      url: "https://127.0.0.1:4173/",
      ignoreHTTPSErrors: true,
      reuseExistingServer: !isCI && !measuringBrowserCost,
      timeout: measuringBrowserCost ? measurementStartupMilliseconds : normalStartupMilliseconds,
    },
    {
      command: `PLAYWRIGHT_TLS_KEY=/tmp/fidy-playwright-key.pem PLAYWRIGHT_TLS_CERT=/tmp/fidy-playwright-cert.pem ${fixtureRuntime} ../server/cloudflare/browser-acceptance-preview.ts`,
      url: "https://127.0.0.1:4174/health",
      ignoreHTTPSErrors: true,
      reuseExistingServer: !isCI && !measuringBrowserCost,
      timeout: measuringBrowserCost ? measurementStartupMilliseconds : normalStartupMilliseconds,
    },
  ],
});
