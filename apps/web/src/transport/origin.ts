import { Predicate } from "effect";
import { installedOrigins, isHttpOrigin } from "@fidy/server/browser-transport";

const originConfigurationMessage = "VITE_API_ORIGIN must be an HTTP origin";

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

export const browserApiOrigin = ({
  configured,
  browserOrigin,
}: {
  configured: unknown;
  browserOrigin: string;
}): string => {
  if (configured === "installed") {
    if (browserOrigin === installedOrigins.acceptance.browser) {
      return installedOrigins.acceptance.api;
    }

    if (browserOrigin === installedOrigins.production.browser) {
      return installedOrigins.production.api;
    }

    throw new Error("Unexpected installed browser origin");
  }

  return parseApiOrigin(configured);
};
