export const browserSessionBindingPath = "/web/session/binding";
export const browserSessionBindingHeader = "Fidy-Session-Binding";
export const telemetryTraceHeader = "Fidy-Trace-Id";
export const telemetryTraceIdPatternSource = "^(?!0{32}$)[0-9a-f]{32}$";

export const connectionBrowserPaths = {
  review: "/web/connections/review",
  begin: "/web/connections/begin",
} as const;
