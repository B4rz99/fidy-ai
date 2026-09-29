/** Persists explicit Worker logs while excluding automatic request invocation records. */
export const freeTierWorkerObservability = {
  enabled: true,
  headSamplingRate: 1,
  logs: {
    enabled: true,
    headSamplingRate: 1,
    invocationLogs: false,
    persist: true,
  },
} as const;
