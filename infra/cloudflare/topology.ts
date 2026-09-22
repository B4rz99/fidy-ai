/** Non-secret PAT fixture accepted only by the local canonical-operation harness. */
export const localCanonicalReadBearer = "fin_localdev_local-emulation-category-read-token";

export const resolveLocalCanonicalReadBearer = (development: boolean): string =>
  development ? localCanonicalReadBearer : "";

/** Stable production network surface consumed by the Alchemy stack and topology tests. */
export const productionTopology = {
  core: {
    d1Binding: "DB",
    localPort: 8788,
    workersDev: false,
  },
  ingress: {
    coreBinding: "CORE",
    hostname: "api.fidyapp.com",
    localPort: 8787,
    workersDev: false,
  },
  web: {
    adoptExistingWorker: true,
    hostname: "app.fidyapp.com",
    redirects: ["fidyapp.com"],
    workerName: "fidy-web",
    workersDev: false,
  },
} as const;
