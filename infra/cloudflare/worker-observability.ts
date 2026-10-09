/** Keeps diagnostic logs while removing request queries and automatic invocation records. */
export const freeTierWorkerObservability = {
  enabled: true,
  headSamplingRate: 1,
  redactQueryString: true,
  logs: {
    enabled: true,
    headSamplingRate: 1,
    invocationLogs: false,
    persist: true,
  },
} as const;
