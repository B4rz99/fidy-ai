export type DashboardOutcome = "ready" | "refused" | "timeout" | "no-fresh-read";
export type DashboardObservation = Readonly<{ outcome: DashboardOutcome; durationMs: number }>;
type CohortSummary = Readonly<{
  offered: number;
  ready: number;
  refusals: number;
  timeouts: number;
  missingFreshReads: number;
  statistics:
    | Readonly<{ status: "unavailable" }>
    | Readonly<{ status: "available"; p95Ms: number; p99Ms: number; maximumMs: number }>;
}>;
const p95 = 0.95;
const p99 = 0.99;
/** Successful fresh paints alone qualify for percentiles; every offered attempt retains its outcome. */
export const summarizeDashboardSamples = (
  samples: ReadonlyArray<DashboardObservation>
): CohortSummary => {
  const durations = samples
    .filter((sample) => sample.outcome === "ready")
    .map((sample) => sample.durationMs)
    .sort((left, right) => left - right);
  const maximumMs = durations.at(-1);
  return {
    offered: samples.length,
    ready: durations.length,
    refusals: samples.filter((sample) => sample.outcome === "refused").length,
    timeouts: samples.filter((sample) => sample.outcome === "timeout").length,
    missingFreshReads: samples.filter((sample) => sample.outcome === "no-fresh-read").length,
    statistics:
      maximumMs === undefined
        ? { status: "unavailable" }
        : {
            status: "available",
            maximumMs,
            p95Ms: durations[Math.ceil(durations.length * p95) - 1] ?? maximumMs,
            p99Ms: durations[Math.ceil(durations.length * p99) - 1] ?? maximumMs,
          },
  };
};

export const calibrateDashboardClock = (): Readonly<{
  positiveTickMs: number;
  clockReadOverheadMs: number;
}> => {
  const iterations = 1000;
  const start = performance.now();
  let previous = start;
  let positiveTickMs = Infinity;
  for (let index = 0; index < iterations; index++) {
    const current = performance.now();
    if (current > previous) positiveTickMs = Math.min(positiveTickMs, current - previous);
    previous = current;
  }
  return {
    positiveTickMs: Number.isFinite(positiveTickMs) ? positiveTickMs : 0,
    clockReadOverheadMs: (performance.now() - start) / iterations,
  };
};

export const installDashboardNavigationMeasurement = (): void => {
  document.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest("a");
      if (link === null || new URL(link.href).pathname !== "/app/dashboard") return;
      performance.clearMarks("dashboard-fresh-paint");
      performance.clearMarks("dashboard-navigation-start");
      performance.mark("dashboard-navigation-start");
    },
    true
  );
};

/** A retained display without a new completed read cannot qualify. Duration stays on the browser clock. */
export const installDashboardMeasurement = (): void => {
  const state = { response: -1, pending: -1, scheduled: -1 };
  const observerWork = new Map<number, number>();
  const started = (): number =>
    performance.getEntriesByName("dashboard-navigation-start").at(-1)?.startTime ?? 0;
  const ready = (): boolean =>
    document
      .querySelector('[data-dashboard-read-state="ready"] .dashboard-header button:enabled')
      ?.checkVisibility() === true;
  const navigation = performance.getEntriesByType("navigation")[0];
  const freshRead = (start: number): boolean =>
    state.response >= start ||
    (start === 0 &&
      navigation instanceof PerformanceNavigationTiming &&
      navigation.responseStatus === successfulStatus &&
      document.getElementById("dashboard-initial")?.dataset.status === "200");
  const successfulStatus = 200;
  const inspect = (): void => {
    const before = performance.now();
    const navigationStart = started();
    if (document.querySelector('[data-dashboard-read-state="pending"]') !== null) {
      state.pending = navigationStart;
    }
    const eligible =
      freshRead(navigationStart) &&
      (navigationStart === 0 || state.pending === navigationStart) &&
      ready() &&
      state.scheduled !== navigationStart;
    const previousWork = observerWork.get(navigationStart) ?? 0;
    observerWork.set(navigationStart, previousWork + performance.now() - before);
    if (!eligible) return;
    state.scheduled = navigationStart;
    requestAnimationFrame(() => {
      const paintedAt = performance.now();
      requestAnimationFrame(() => {
        if (navigationStart !== started() || !ready()) return;
        const durationMs = paintedAt - navigationStart;
        const confirmationOverheadMs = performance.now() - paintedAt;
        const observerWorkMs = observerWork.get(navigationStart) ?? 0;
        const detail = { durationMs, confirmationOverheadMs, observerWorkMs };
        performance.mark("dashboard-fresh-paint", { detail });
      });
    });
  };
  const changes = { subtree: true, childList: true, attributes: true };
  new MutationObserver(inspect).observe(document, changes);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (
        entry instanceof PerformanceResourceTiming &&
        new URL(entry.name).pathname === "/dashboard/view"
      ) {
        state.response = entry.startTime;
      }
    }
    inspect();
  }).observe({ type: "resource", buffered: true });
};
