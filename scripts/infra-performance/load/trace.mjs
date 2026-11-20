// Join already-emitted production spans after measurement. Persist only allowlisted durations.
const tracePattern = /\btraceId["']?\s*:\s*["']([0-9a-f]{32})["']/;
const operationPattern =
  /["']fidy\.operation["']\s*:\s*["'](worker\.public\.fetch|worker\.core\.fetch)["']/;
const elapsedPattern = /\blatencyMilliseconds["']?\s*:\s*(\d+(?:\.\d+)?)\s*[,}]/;
export const correlateWorkerSpans = (logs, calls) => {
  const byTrace = new Map();
  for (const log of logs) {
    if (!/\bevent["']?\s*:\s*["']span["']/.test(log)) continue;
    const trace = tracePattern.exec(log)?.[1];
    const operation = operationPattern.exec(log)?.[1];
    const elapsed = elapsedPattern.exec(log)?.[1];
    if (!trace || !operation || elapsed === undefined) continue;
    const span = byTrace.get(trace) ?? {};
    const key = operation === "worker.public.fetch" ? "ingressMs" : "coreMs";
    // More than one matching operation cannot identify a unique span for this response.
    span[key] = key in span ? null : Number(elapsed);
    byTrace.set(trace, span);
  }
  return calls.map(({ traces, ...row }) => ({
    ...row,
    responses: traces.map((trace) => {
      const span = byTrace.get(trace);
      return { ingressMs: span?.ingressMs ?? null, coreMs: span?.coreMs ?? null };
    }),
  }));
};
