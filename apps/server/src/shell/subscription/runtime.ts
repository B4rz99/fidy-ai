import { Option } from "effect";
import { SubscriptionEnrollmentGroup } from "./contract";
import { matchesRouteTemplate } from "~/shell/public-http/operations";

const transports = Object.values(SubscriptionEnrollmentGroup.endpoints);

const browserHeaders = ["content-type", "cookie", "origin"] as const;

export const paymentEnrollmentTransport = (
  path: string
): Option.Option<{
  readonly operation: (typeof transports)[number]["identifier"];
  readonly method: (typeof transports)[number]["method"];
  readonly parameter: Option.Option<string>;
  readonly forwardedHeaders: typeof browserHeaders;
}> => {
  for (const endpoint of transports) {
    if (!matchesRouteTemplate({ template: endpoint.path, path })) continue;

    const parameter =
      endpoint.params === undefined
        ? Option.none<string>()
        : Option.fromUndefinedOr(path.split("/").at(-1));

    if (Option.isSome(parameter) && !/^[0-9a-f-]{36}$/u.test(parameter.value)) continue;

    return Option.some({
      operation: endpoint.identifier,
      method: endpoint.method,
      parameter,
      forwardedHeaders: browserHeaders,
    });
  }

  return Option.none();
};
