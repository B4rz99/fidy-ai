import { installedOrigins, isHttpOrigin } from "@fidy/server/browser-transport";

const originConfigurationMessage = "VITE_API_ORIGIN must be an HTTP origin";

/**
 * Parses required browser configuration as one credential-free HTTP(S) API origin. Paths, queries,
 * fragments, credentials, and non-URL values fail closed before the transport is constructed.
 */
export const parseApiOrigin = (configured: unknown, browserOrigin?: string): string => {
  if (configured === "installed") {
    if (browserOrigin === installedOrigins.acceptance.browser) {
      return installedOrigins.acceptance.api;
    }
    if (browserOrigin === installedOrigins.production.browser) {
      return installedOrigins.production.api;
    }
    throw new Error("Unexpected installed browser origin");
  }
  if (typeof configured !== "string" || configured.length === 0) {
    throw new Error(originConfigurationMessage);
  }

  try {
    const url = new URL(configured);
    if (!isHttpOrigin(url)) {
      throw new Error(originConfigurationMessage);
    }
    return url.origin;
  } catch {
    throw new Error(originConfigurationMessage);
  }
};
