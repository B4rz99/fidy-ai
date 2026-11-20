const requestRoles = new Map([
  ["/categories", "categories"],
  ["/dashboard/catalog", "dashboard-catalog"],
  ["/ingestion/review-workspace", "review-count"],
  ["/transactions", "history"],
  ["/user", "user"],
  ["/web/session/binding", "binding"],
]);

/**
 * Capture Chromium's API lifecycle, including CORS preflights and still-active requests.
 * @param {import("@playwright/test").CDPSession} cdp Measured page's DevTools session.
 * @param {string} api API origin.
 */
export const observeApiTimeline = (cdp, api) => {
  const maxRequests = 64;
  const secondsToMilliseconds = 1000;
  /** @type {Map<string, {role: string, method: string, started: number, epoch: number,
   * status?: number, headers?: number, completed?: number, failed?: boolean}>} */
  const requests = new Map();
  cdp.on("Network.requestWillBeSent", ({ requestId, request, timestamp, wallTime }) => {
    const destination = new URL(request.url);
    if (destination.origin !== api) return;
    if (requests.size >= maxRequests) {
      const oldest = requests.keys().next();
      if (!oldest.done) requests.delete(oldest.value);
    }
    requests.set(requestId, {
      role: requestRoles.get(destination.pathname) ?? "other-api",
      method: request.method === "OPTIONS" ? "OPTIONS" : request.method === "GET" ? "GET" : "other",
      started: timestamp,
      epoch: wallTime * secondsToMilliseconds,
    });
  });
  cdp.on("Network.responseReceived", ({ requestId, response, timestamp }) => {
    const request = requests.get(requestId);
    if (request === undefined) return;
    request.status = response.status;
    request.headers = timestamp;
  });
  cdp.on("Network.loadingFinished", ({ requestId, timestamp }) => {
    const request = requests.get(requestId);
    if (request !== undefined) request.completed = timestamp;
  });
  cdp.on("Network.loadingFailed", ({ requestId, timestamp }) => {
    const request = requests.get(requestId);
    if (request === undefined) return;
    request.failed = true;
    request.completed = timestamp;
  });

  /** @param {number} clickEpochMs Real click time on the browser epoch clock. */
  return (clickEpochMs) => {
    const lookbackMs = 1500;
    return Array.from(requests.values()).flatMap((request) => {
      const startAfterClickMs = request.epoch - clickEpochMs;
      const offsetFromClick = (timestamp) =>
        startAfterClickMs + (timestamp - request.started) * secondsToMilliseconds;
      const completedAfterClickMs =
        request.completed === undefined ? undefined : offsetFromClick(request.completed);
      if (completedAfterClickMs !== undefined && completedAfterClickMs < -lookbackMs) return [];
      return [{
        role: request.role,
        method: request.method,
        status: request.status,
        startAfterClickMs,
        headersAfterClickMs: request.headers === undefined ? undefined : offsetFromClick(request.headers),
        completedAfterClickMs,
        failed: request.failed,
      }];
    });
  };
};

const timingNames = new Set([
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
  "dashboard-source",
  "dashboard-projection",
  "dashboard-audit",
  "dashboard-hop",
]);

/** @param {import("@playwright/test").Response} reply Measured response. */
const serverTiming = async (reply) => {
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

/**
 * Use one browser clock for the real input event, Chromium request timings and paint.
 * Resource names are used in the page only. Export fixed roles and elapsed milliseconds.
 * @param {import("@playwright/test").Locator} control Control about to be clicked.
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
   * @param {import("@playwright/test").Response} reply Completed canonical response.
   * @param {number} paintedAt Browser time of the second frame callback.
   * @param {number} [controlsReadyAt] Browser time when the observed fresh controls became enabled.
   */
  return async (reply, paintedAt, controlsReadyAt) => {
    try {
      const browser = await handle.evaluate(
        ({ clickAt }, { canonicalUrl, paintedAt, controlsReadyAt }) => {
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
          const relatedRequests = new Map([
            ["/categories", "categories"],
            ["/dashboard/catalog", "dashboard-catalog"],
            ["/user", "user"],
            ["/web/session/binding", "binding"],
          ]);
          return {
            status: "observed",
            clickEpochMs: performance.timeOrigin + clickAt,
            windowMs,
            clickToRequestMs: request.startTime - clickAt,
            requestToResponseMs: request.duration,
            responseToPaintMs: paintedAt - request.responseEnd,
            ...(controlsReadyAt === undefined
              ? {}
              : {
                  responseToControlsReadyMs: controlsReadyAt - request.responseEnd,
                  controlsReadyToPaintMs: paintedAt - controlsReadyAt,
                }),
            resources: resources.flatMap((entry) => {
              const url = new URL(entry.name);
              let role;
              if (entry === request) role = "canonical";
              else if (url.origin === api) {
                role =
                  url.pathname === "/ingestion/review-workspace" && url.searchParams.get("limit") === "0"
                    ? "review-count"
                    : relatedRequests.get(url.pathname);
              }
              else if (url.origin === location.origin && /\.(?:js|css)$/u.test(url.pathname)) {
                role = "script-or-style";
              }
              if (role === undefined) return [];
              return [
                {
                  role,
                  startAfterClickMs: entry.startTime - clickAt,
                  endAfterClickMs: entry.responseEnd - clickAt,
                },
              ];
            }),
          };
        },
        { canonicalUrl: reply.url(), paintedAt, controlsReadyAt }
      );
      return { ...browser, serverTiming: await serverTiming(reply) };
    } finally {
      await handle.dispose();
    }
  };
};
