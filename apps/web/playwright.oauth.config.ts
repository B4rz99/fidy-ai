import { browserAcceptanceTopologies } from "../server/cloudflare/browser-acceptance/contract";

const topology = browserAcceptanceTopologies.oauth;
const { defineConfig } = await import("@playwright/test");

/** Isolated built-web/Core OAuth journeys do not borrow another worktree's acceptance servers. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "oauth-review.spec.ts",
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: topology.app,
    ignoreHTTPSErrors: true,
    launchOptions: { args: ["--ignore-certificate-errors"] },
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command: `openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/fidy-oauth-key.pem -out /tmp/fidy-oauth-cert.pem -subj /CN=127.0.0.1 -days 1 >/dev/null 2>&1 && VITE_API_ORIGIN=${topology.api} bun --bun vite build --mode production --outDir dist/oauth-acceptance && CLI_ACCEPTANCE_MODE=${topology.mode} PLAYWRIGHT_TLS_KEY=/tmp/fidy-oauth-key.pem PLAYWRIGHT_TLS_CERT=/tmp/fidy-oauth-cert.pem PREVIEW_ROOT=dist/oauth-acceptance PREVIEW_PORT=${topology.appPort} bun scripts/serve-preview.ts`,
      url: `${topology.app}/`,
      ignoreHTTPSErrors: true,
      timeout: 120_000,
    },
    {
      command: `CLI_ACCEPTANCE_MODE=${topology.mode} PLAYWRIGHT_TLS_KEY=/tmp/fidy-oauth-key.pem PLAYWRIGHT_TLS_CERT=/tmp/fidy-oauth-cert.pem bun ../server/cloudflare/browser-acceptance-preview.ts`,
      url: `${topology.api}/health`,
      ignoreHTTPSErrors: true,
      timeout: 120_000,
    },
  ],
});
