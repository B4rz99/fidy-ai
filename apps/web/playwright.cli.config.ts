const { defineConfig } = await import("@playwright/test");

/** Dedicated loopback topology avoids borrowing or killing another session's acceptance servers. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "cli-login.spec.ts",
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "https://127.0.0.1:4183",
    ignoreHTTPSErrors: true,
    launchOptions: { args: ["--ignore-certificate-errors"] },
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command:
        "openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/fidy-cli-key.pem -out /tmp/fidy-cli-cert.pem -subj /CN=127.0.0.1 -days 1 >/dev/null 2>&1 && VITE_API_ORIGIN=https://127.0.0.1:4184 bun --bun vite build --mode production --outDir dist/cli-acceptance && CLI_ACCEPTANCE_MODE=cli PLAYWRIGHT_TLS_KEY=/tmp/fidy-cli-key.pem PLAYWRIGHT_TLS_CERT=/tmp/fidy-cli-cert.pem PREVIEW_ROOT=dist/cli-acceptance PREVIEW_PORT=4183 bun scripts/serve-preview.ts",
      url: "https://127.0.0.1:4183/",
      ignoreHTTPSErrors: true,
      timeout: 120_000,
    },
    {
      command:
        "CLI_ACCEPTANCE_MODE=cli PLAYWRIGHT_TLS_KEY=/tmp/fidy-cli-key.pem PLAYWRIGHT_TLS_CERT=/tmp/fidy-cli-cert.pem bun ../server/cloudflare/browser-acceptance-preview.ts",
      url: "https://127.0.0.1:4184/health",
      ignoreHTTPSErrors: true,
      timeout: 120_000,
    },
  ],
});
