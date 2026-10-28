import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { Config, Effect } from "effect";

const dataset = Effect.runSync(Config.String("FIDY_ASSESSMENT").pipe(Config.withDefault("")));
const development =
  Effect.runSync(Config.String("FIDY_ASSESSMENT_BUILD").pipe(Config.withDefault("production"))) ===
  "development";
const executablePath = Effect.runSync(
  Config.String("ASSESSMENT_CHROMIUM").pipe(Config.withDefault(""))
);
export default defineConfig({
  ...base,
  workers: 1,
  retries: 0,
  ...(dataset !== ""
    ? { projects: [{ name: "assessment", testMatch: "performance.assessment.ts" }] }
    : {}),
  timeout: 600_000,
  reporter: [
    ["line"],
    [
      "json",
      {
        outputFile: `../../reports/performance/assessment-${development ? "development-" : ""}${dataset === "" ? "baseline" : dataset}.json`,
      },
    ],
  ],
  webServer: Array.isArray(base.webServer)
    ? base.webServer.map((server, index) => ({
        ...server,
        command:
          development && index === 0
            ? server.command.replace(
                /VITE_API_ORIGIN=.*$/u,
                "VITE_API_ORIGIN=https://127.0.0.1:4174 bun scripts/serve-assessment-dev.ts"
              )
            : server.command,
        timeout: 600_000,
        reuseExistingServer: false,
      }))
    : base.webServer,
  use: {
    ...base.use,
    launchOptions: {
      ...base.use?.launchOptions,
      ...(executablePath === "" ? {} : { executablePath }),
    },
  },
});
