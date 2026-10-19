import { defineConfig } from "@playwright/test";

const build =
  process.env.SITE_BROWSER_PREBUILT === "true" ? "bun scripts/check-artifact.ts" : "bun run build";

export default defineConfig({
  testDir: "./e2e",
  workers: 4,
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:4322", trace: "off", screenshot: "off", video: "off" },
  webServer: {
    command: `${build} && astro preview --ignore-lock --host 127.0.0.1 --port 4322`,
    url: "http://127.0.0.1:4322",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
