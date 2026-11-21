import { Option } from "effect";
import { ProcessingConsentGroup } from "./contract";

const consentTransports = Object.values(ProcessingConsentGroup.endpoints);

export const processingConsentTransport = (
  path: string
): Option.Option<{
  readonly operation: (typeof consentTransports)[number]["identifier"];
  readonly method: (typeof consentTransports)[number]["method"];
  readonly forwardedHeaders: readonly ["content-type", "cookie", "origin"];
}> => {
  for (const endpoint of consentTransports) {
    if (endpoint.path === path) {
      return Option.some({
        operation: endpoint.identifier,
        method: endpoint.method,
        forwardedHeaders: ["content-type", "cookie", "origin"] as const,
      });
    }
  }

  return Option.none();
};
