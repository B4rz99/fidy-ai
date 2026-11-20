export const freeTierWorkerObservability = {
  enabled: true,
  headSamplingRate: 1,
  redactQueryString: true,
  issues: { enabled: true },
  logs: {
    enabled: true,
    headSamplingRate: 1,
    invocationLogs: false,
    persist: true,
  },
} as const;
