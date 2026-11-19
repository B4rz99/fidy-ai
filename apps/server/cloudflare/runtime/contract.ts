import { installedOrigins } from "../../src/shell/browser-transport/contract";

export const smokePath = "/internal/release-smoke";

export const localCanonicalReadBearer = "fin_localdev_local-emulation-category-read-token";

/** Stable production network surface consumed by the Alchemy stack and topology tests. */
export const productionTopology = {
  docs: { hostname: "docs.fidyapp.com" },
  core: {
    localPort: 8788,
    workersDev: false,
  },
  ingress: {
    coreBinding: "CORE",
    hostname: "api.fidyapp.com",
    localPort: 8787,
    workersDev: false,
  },
  site: { hostname: "fidyapp.com", localPort: 4321, workerName: "fidy-site", workersDev: false },
  web: {
    hostname: "app.fidyapp.com",
    localPort: 5173,
    redirects: [],
    workersDev: false,
  },
} as const;

/** Closed browser origins accepted by the public Worker in each complete topology mode. */
export const browserOrigins = {
  local: `http://127.0.0.1:${productionTopology.web.localPort}`,
  acceptance: "https://127.0.0.1:4173",
  production: installedOrigins.production.browser,
  nativeAcceptance: installedOrigins.acceptance.browser,
} as const;

/** Canonical lowercase release-identity formats shared by deployment and Worker boundaries. */
export const gitRevisionPattern = /^[0-9a-f]{40}$/u;
export const contractDigestPattern = /^[0-9a-f]{64}$/u;
