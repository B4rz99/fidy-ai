import { defineConfig } from "@playwright/test";

const prepare =
  process.env.DOCS_BROWSER_PREBUILT === "true" ? "bun run test:artifact" : "bun run build";

export default defineConfig({
  testDir: "./e2e",
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:4324",
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  },
  webServer: {
    command: `${prepare} && astro preview --ignore-lock --host 127.0.0.1 --port 4324`,
    url: "http://127.0.0.1:4324",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
