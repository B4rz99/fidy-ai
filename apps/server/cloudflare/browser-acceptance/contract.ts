import { Schema } from "effect";

export const BrowserAcceptanceMode = Schema.Literals(["shared", "cli", "oauth"]);
export type BrowserAcceptanceMode = typeof BrowserAcceptanceMode.Type;
export type BrowserAcceptanceTopology = Readonly<{
  mode: BrowserAcceptanceMode;
  app: string;
  api: string;
  operator: string;
  appPort: number;
  apiPort: number;
  operatorPort: number;
}>;
const topology = (mode: BrowserAcceptanceMode, appPort: number): BrowserAcceptanceTopology => ({
  mode,
  appPort,
  apiPort: appPort + 1,
  operatorPort: appPort + 2,
  app: `https://127.0.0.1:${appPort}`,
  api: `https://127.0.0.1:${appPort + 1}`,
  operator: `http://127.0.0.1:${appPort + 2}`,
});
const sharedAppPort = 4173;
const cliAppPort = 4183;
const oauthAppPort = 4193;
/** Synthetic loopback identities owned by broad acceptance composition, never production authority. */
export const browserAcceptanceTopologies = {
  shared: topology("shared", sharedAppPort),
  cli: topology("cli", cliAppPort),
  oauth: topology("oauth", oauthAppPort),
} as const;
