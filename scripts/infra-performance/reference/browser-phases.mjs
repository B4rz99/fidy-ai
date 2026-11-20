const timingNames = new Set([
  "review-workerd",
  "review-route-proof",
  "review-directory",
  "review-owner-hop",
  "review-admission",
  "review-count-sql",
  "review-sql",
  "review-snapshot",
  "review-completion",
  "review-local",

  "canonical-total",
  "canonical-admission",
  "canonical-owner",
  "canonical-standing",
  "canonical-other",
  "canonical-storage",
  "canonical-present",
  "canonical-sql",
  "recovery-r2",
  "recovery-d1",
  "recovery-sql",
]);

/** @param {import("@playwright/test").Response} reply Complete workspace response. */
export const serverTiming = async (reply) => {
  const header = await reply.headerValue("server-timing");
  const phases = {};
  for (const entry of header?.split(",") ?? []) {
    const match = /^\s*([a-z-][a-z0-9-]*);dur=(\d+(?:\.\d+)?)\s*$/u.exec(entry);
    if (match && timingNames.has(match[1])) {
      (phases[match[1]] ??= []).push(Number(match[2]));
    }
  }
  return phases;
};

const relatedRequests = {
  "/categories": "categories",
  "/ingestion/review-workspace": "review-summary",
  "/ingestion/review-workspace/context": "review-context",
  "/user": "user",
  "/web/session/binding": "binding",
};
/**
 * @param {{clickAt: number | undefined}} capture Observed input time.
 * @param {{canonicalUrl: string, paintedAt: number, controlsReadyAt?: number, relatedRequests: Record<string, string>}} observation Measured response, frame times and allowlisted paths.
 */
const browserPhases = (
  { clickAt },
  { canonicalUrl, paintedAt, controlsReadyAt, relatedRequests }
) => {
  if (clickAt === undefined) return { status: "click-unobserved" };
  const windowMs = paintedAt - clickAt;
  const resources = performance
    .getEntriesByType("resource")
    .filter((entry) => entry.responseEnd >= clickAt && entry.startTime <= paintedAt);
  const canonical = resources.filter(
    (entry) => entry.name === canonicalUrl && entry.startTime >= clickAt
  );
  if (canonical.length !== 1) {
    return { status: "request-unresolved", canonicalObservations: canonical.length, windowMs };
  }
  const request = canonical[0];
  const api = new URL(canonicalUrl).origin;
  /** @param {URL} url Browser resource URL. */
  const requestRole = (url) => {
    if (url.origin !== api) return undefined;
    const fixed = relatedRequests[url.pathname];
    if (fixed === "review-summary" && url.searchParams.get("limit") === "0") return "review-count";
    if (fixed !== undefined) return fixed;
    const item = /^\/ingestion\/review-workspace\/[^/]+(\/material)?$/u.exec(url.pathname);
    if (item) return item[1] ? "review-material" : "review-item";
    return undefined;
  };
  /** @param {PerformanceResourceTiming} entry Completed browser request. */
  const resourceRole = (entry) => {
    if (entry === request) return "canonical";
    const url = new URL(entry.name);
    if (url.origin === location.origin && /\.(?:js|css)$/u.test(url.pathname)) {
      return "script-or-style";
    }
    return requestRole(url);
  };
  const ready =
    controlsReadyAt === undefined
      ? {}
      : {
          controlsReadyAfterClickMs: controlsReadyAt - clickAt,
          controlsReadyToPaintMs: paintedAt - controlsReadyAt,
        };
  return {
    status: "observed",
    windowMs,
    clickToRequestMs: request.startTime - clickAt,
    requestToResponseMs: request.duration,
    responseToPaintMs: paintedAt - request.responseEnd,
    ...ready,
    resources: resources
      .map((entry) => ({
        role: resourceRole(entry),
        startAfterClickMs: entry.startTime - clickAt,
        endAfterClickMs: entry.responseEnd - clickAt,
      }))
      .filter(({ role }) => role !== undefined),
  };
};

/**
 * Use one browser clock for real input, resource timing and paint.
 * Export only fixed resource roles and elapsed milliseconds.
 * @param {import("@playwright/test").Locator} control Measured browser control.
 */
export const trackBrowserClick = async (control) => {
  const handle = await control.evaluateHandle((element) => {
    const capture = { clickAt: undefined };
    element.addEventListener(
      "click",
      () => {
        capture.clickAt = performance.now();
      },
      { capture: true, once: true }
    );
    return capture;
  });
  /**
   * @param {import("@playwright/test").Response} reply Successful workspace response.
   * @param {number} paintedAt Browser time at the paint checkpoint.
   * @param {number} [controlsReadyAt] Browser time when controls were first found usable.
   */
  return async (reply, paintedAt, controlsReadyAt) => {
    try {
      const browser = await handle.evaluate(browserPhases, {
        canonicalUrl: reply.url(),
        paintedAt,
        controlsReadyAt,
        relatedRequests,
      });
      return { ...browser, serverTiming: await serverTiming(reply) };
    } finally {
      await handle.dispose();
    }
  };
};
