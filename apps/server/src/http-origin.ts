/**
 * Reports whether a parsed URL is exactly a credential-free HTTP(S) origin.
 * A root slash is the only accepted path; credentials, query parameters, and
 * fragments are rejected so callers can compare the returned origin exactly.
 */
export const isHttpOrigin = (url: URL): boolean =>
  (url.protocol === "http:" || url.protocol === "https:") &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  url.pathname === "/" &&
  url.search.length === 0 &&
  url.hash.length === 0;
