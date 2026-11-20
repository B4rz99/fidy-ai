// Join already-emitted production spans after measurement. Persist only allowlisted durations.
const tracePattern = /\btraceId["']?\s*:\s*["']([0-9a-f]{32})["']/;
const operationPattern =
  /["']fidy\.operation["']\s*:\s*["'](worker\.public\.fetch|worker\.core\.fetch)["']/;
const elapsedPattern = /\blatencyMilliseconds["']?\s*:\s*(\d+(?:\.\d+)?)\s*[,}]/;
/** @param {string} log Production telemetry message. */
const readSpan = (log) => {
  if (!/\bevent["']?\s*:\s*["']span["']/.test(log)) return undefined;
  const trace = tracePattern.exec(log)?.[1],
    operation = operationPattern.exec(log)?.[1],
    elapsed = elapsedPattern.exec(log)?.[1];
  if (trace && operation && elapsed !== undefined) {
    return { key: trace + "." + operation, elapsed: Number(elapsed) };
  }
  return undefined;
};
/** @param {number[]} values Durations for one trace and operation. */
const uniqueDuration = (values = []) => (values.length === 1 ? values[0] : null);
/**
 * @param {string[]} logs Production structured log messages.
 * @param {import("./contracts.d.mts").SpanCall[]} calls Observed response traces.
 */
export const correlateWorkerSpans = (logs, calls) => {
  /** @type {Map<string, number[]>} */
  const byTrace = new Map();
  for (const log of logs) {
    const span = readSpan(log);
    if (span) byTrace.set(span.key, [...(byTrace.get(span.key) ?? []), span.elapsed]);
  }
  return calls.map(({ traces, ...row }) => ({
    ...row,
    responses: traces.map((trace) => ({
      ingressMs: uniqueDuration(byTrace.get(trace + ".worker.public.fetch")),
      coreMs: uniqueDuration(byTrace.get(trace + ".worker.core.fetch")),
    })),
  }));
};
