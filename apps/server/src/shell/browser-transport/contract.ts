/** Credential-free HTTP origin shared by browser configuration and server CORS policy. */
export const isHttpOrigin = (url: URL): boolean =>
  (url.protocol === "http:" || url.protocol === "https:") &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  url.pathname === "/" &&
  url.search.length === 0 &&
  url.hash.length === 0;

export const browserSessionBindingPath = "/web/session/binding";
export const browserSessionBindingHeader = "Fidy-Session-Binding";
export const telemetryTraceHeader = "Fidy-Trace-Id";
