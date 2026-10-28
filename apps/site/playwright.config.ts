import { defineConfig } from "@playwright/test";

const build =
  process.env.SITE_BROWSER_PREBUILT === "true" ? "bun scripts/check-artifact.ts" : "bun run build";
const publicOrigin = process.env.SITE_PUBLIC_ORIGIN === "https://fidyapp.com";

export default defineConfig({
  testDir: "./e2e",
  workers: 4,
  fullyParallel: true,
  use: {
    baseURL: publicOrigin ? "https://fidyapp.com" : "http://127.0.0.1:4322",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: publicOrigin
    ? undefined
    : {
        command: `${build} && wrangler dev --config wrangler.test.jsonc --ip 127.0.0.1 --port 4322`,
        url: "http://127.0.0.1:4322",
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
