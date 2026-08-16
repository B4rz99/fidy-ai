import { isHttpOrigin } from "@fidy/server/client";
import { Predicate } from "effect";

const originConfigurationMessage = "VITE_API_ORIGIN must be an HTTP origin";

/**
 * Parses required browser configuration as one credential-free HTTP(S) API origin. Paths, queries,
 * fragments, credentials, and non-URL values fail closed before the transport is constructed.
 */
export const parseApiOrigin = (configured: unknown): string => {
  if (!Predicate.isString(configured) || configured.length === 0) {
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
