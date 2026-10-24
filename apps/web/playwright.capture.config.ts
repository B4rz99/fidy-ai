import { defineConfig } from "@playwright/test";
import browserConfig from "./playwright.config";

// Explicit local-only screenshot harness, excluded from the default browser/CI suite.
export default defineConfig({
  ...browserConfig,
  projects: [{ name: "capture", testMatch: "login-visual.capture.ts" }],
});
