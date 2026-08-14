import { isHttpOrigin } from "@fidy/server/client";

const originConfigurationMessage = "VITE_API_ORIGIN must be an HTTP origin";

/**
 * Parses required browser configuration as one credential-free HTTP(S) API
 * origin. Paths, queries, fragments, and non-URL values throw; valid values are
 * normalized to the platform URL origin used for every canonical API request.
 */
export const parseApiOrigin = (configured: unknown): string => {
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
