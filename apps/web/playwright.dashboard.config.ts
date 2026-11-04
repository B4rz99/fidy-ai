import base from "./playwright.config";
import { browserAcceptanceTopology } from "../server/cloudflare/browser-acceptance/operations";

const { defineConfig } = await import("@playwright/test");
const topology = browserAcceptanceTopology();
export default defineConfig({
  ...base,
  projects: [{ name: "dashboard", testMatch: "dashboard-html.spec.ts" }],
  workers: 1,
  retries: 0,
  timeout: 90_000,
  use: { ...base.use, baseURL: topology.app },
  webServer: Array.isArray(base.webServer)
    ? base.webServer.map((server) => ({
        ...server,
        command: server.command
          .replaceAll("4173", String(topology.appPort))
          .replaceAll("4174", String(topology.apiPort)),
        url: server.url
          ?.replace("4173", String(topology.appPort))
          .replace("4174", String(topology.apiPort)),
        reuseExistingServer: false,
      }))
    : base.webServer,
});
