import production from "./playwright.cli.config";

const { defineConfig } = await import("@playwright/test");

export default defineConfig({
  ...production,
  testMatch: [
    "workspace-requests.spec.ts",
    "workspace-navigation.spec.ts",
    "oauth-navigation.spec.ts",
    "consent-navigation.spec.ts",
  ],
  grepInvert: /mobile/u,
  use: { ...production.use, viewport: { width: 1280, height: 720 } },
});
