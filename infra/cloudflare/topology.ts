/** Stable production network surface consumed by the Alchemy stack and topology tests. */
export const productionTopology = {
  core: {
    workersDev: false,
  },
  ingress: {
    coreBinding: "CORE",
    hostname: "api.fidyapp.com",
    workersDev: false,
  },
  web: {
    hostname: "app.fidyapp.com",
    redirects: ["fidyapp.com"],
    workersDev: false,
  },
} as const;
