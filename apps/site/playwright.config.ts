import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 2,
  use: { baseURL: "http://127.0.0.1:4322", trace: "off", screenshot: "off", video: "off" },
  webServer: {
    command: "bun run build && astro preview --ignore-lock --host 127.0.0.1 --port 4322",
    url: "http://127.0.0.1:4322",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
