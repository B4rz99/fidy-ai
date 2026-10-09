import { defineConfig } from "@playwright/test";

/** Screenshot-only public builds: no credentials, API fixtures or authenticated pages. */
export default defineConfig({
  testDir: "./public-preview",
  outputDir: "./test-results/public-preview",
  workers: 1,
  retries: 0,
  reporter: "line",
  use: { colorScheme: "light", reducedMotion: "reduce", trace: "off", video: "off" },
  projects: [
    {
      name: "before-desktop",
      use: { baseURL: "http://127.0.0.1:4190", viewport: { width: 1180, height: 757 } },
    },
    {
      name: "after-desktop",
      use: { baseURL: "http://127.0.0.1:4191", viewport: { width: 1180, height: 757 } },
    },
    {
      name: "before-mobile",
      use: { baseURL: "http://127.0.0.1:4190", viewport: { width: 390, height: 844 } },
    },
    {
      name: "after-mobile",
      use: { baseURL: "http://127.0.0.1:4191", viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: [
    {
      command:
        "bun --bun vite preview --host 127.0.0.1 --port 4190 --strictPort --outDir preview-dist",
      cwd: "../../.preview-base/apps/web",
      url: "http://127.0.0.1:4190",
      reuseExistingServer: false,
    },
    {
      command:
        "bun --bun vite preview --host 127.0.0.1 --port 4191 --strictPort --outDir preview-dist",
      url: "http://127.0.0.1:4191",
      reuseExistingServer: false,
    },
  ],
});
