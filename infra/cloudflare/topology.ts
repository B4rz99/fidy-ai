/** Stable production network surface consumed by the Alchemy stack and topology tests. */
export const productionTopology = {
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
  web: {
    adoptExistingWorker: true,
    hostname: "app.fidyapp.com",
    redirects: ["fidyapp.com"],
    workerName: "fidy-web",
    workersDev: false,
  },
} as const;
