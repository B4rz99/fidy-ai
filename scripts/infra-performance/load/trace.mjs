// Join already-emitted production spans after measurement. Persist only allowlisted durations.
const tracePattern = /\btraceId["']?\s*:\s*["']([0-9a-f]{32})["']/;
const operationPattern =
  /["']fidy\.operation["']\s*:\s*["'](worker\.public\.fetch|worker\.core\.fetch)["']/;
const clockPattern =
  /\[(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d):(?<second>[0-5]\d)\.(?<milliseconds>\d{3})\]/;
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
/** @param {string} log A rendered UTC Worker log line. */
const finishedClock = (log) => {
  const clock = clockPattern.exec(log)?.groups;
  return clock
    ? ((Number(clock.hour) * 60 + Number(clock.minute)) * 60 + Number(clock.second)) * 1000 +
        Number(clock.milliseconds)
    : null;
};
/** @param {number[]} values Durations for one trace and operation. */
const uniqueDuration = (values = []) => (values.length === 1 ? values[0] : null);
/**
 * @param {string[]} logs Production structured log messages.
 * @param {import("./contracts.d.mts").SpanCall[]} calls Observed response traces.
 * @param {boolean} includeClock Retain a bounded UTC ingress completion time each response.
 */
export const correlateWorkerSpans = (logs, calls, includeClock = false) => {
  /** @type {Map<string, number[]>} */
  const byTrace = new Map();
  /** @type {Map<string, number | null>} */
  const clocks = new Map();
  for (const log of logs) {
    const span = readSpan(log);
    if (span) {
      byTrace.set(span.key, [...(byTrace.get(span.key) ?? []), span.elapsed]);
      if (includeClock && span.key.endsWith(".worker.public.fetch")) {
        clocks.set(span.key, clocks.has(span.key) ? null : finishedClock(log));
      }
    }
  }
  return calls.map(({ traces, ...row }) => ({
    ...row,
    responses: traces.map((trace) => ({
      ingressMs: uniqueDuration(byTrace.get(trace + ".worker.public.fetch")),
      coreMs: uniqueDuration(byTrace.get(trace + ".worker.core.fetch")),
      ...(includeClock
        ? { ingressFinishedClockMs: clocks.get(trace + ".worker.public.fetch") ?? null }
        : {}),
    })),
  }));
};
