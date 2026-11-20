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
   * @param {number} [controlsReadyAt] Browser time when the observed fresh view first became usable.
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
          return {
            status: "observed",
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
              else if (url.origin === api && url.pathname === "/categories") role = "categories";
              else if (url.origin === api && url.pathname === "/web/session/binding") role = "binding";
              else if (url.origin === location.origin && /\.(?:js|css)$/u.test(url.pathname)) {
                role = "script-or-style";
              } else return [];
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
