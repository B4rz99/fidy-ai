import { defineConfig } from "@playwright/test";

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
    command: "bun run build && astro preview --ignore-lock --host 127.0.0.1 --port 4324",
    url: "http://127.0.0.1:4324",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
