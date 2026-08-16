import { defineConfig } from "@playwright/test";

/** Browser checks intentionally exercise the built static shell, not a development server. */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command:
      "VITE_API_ORIGIN=https://playwright.invalid bun --bun vite build --mode test --outDir playwright-dist && bun --bun vite preview --host 127.0.0.1 --port 4173 --outDir playwright-dist",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
