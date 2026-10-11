import { Effect, Option } from "effect";
import { FetchHttpClient, type HttpClient, HttpClientRequest } from "effect/http";
import { type CliReleaseHttpService, OutboundHttpFailure } from "~/shell/outbound-http/contract";
import { makeProviderTransport } from "./transport";

const manifestUrl = "https://github.com/B4rz99/fidy-ai/releases/latest/download/latest.txt";
const maximumRequests = 3;
const maximumResponseBytes = 4_096;
const redirectStatus = 300;
const clientErrorStatus = 400;
const assetHosts = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

const unavailable = (): OutboundHttpFailure =>
  new OutboundHttpFailure({
    reason: "invalid-destination",
    responseStatus: Option.none(),
    responseHeaders: {},
  });

const allowedRedirect = (url: URL): boolean => {
  if (
    url.protocol !== "https:" ||
    [url.username, url.password, url.port, url.hash].some((part) => part.length > 0)
  ) {
    return false;
  }
  if (url.hostname === "github.com") {
    return (
      url.search.length === 0 &&
      /^\/B4rz99\/fidy-ai\/releases\/download\/cli-v[0-9]+\.[0-9]+\.[0-9]+\/latest\.txt$/u.test(
        url.pathname
      )
    );
  }
  return (
    assetHosts.has(url.hostname) && url.pathname.startsWith("/github-production-release-asset/")
  );
};

/** A fixed anonymous GET and at most two reviewed HTTPS redirects; all response bytes cross shared policy. */
export const cliReleaseHttp = (client: HttpClient.HttpClient): CliReleaseHttpService => {
  const http = makeProviderTransport("github")(client);
  return {
    readLatest: () =>
      Effect.gen(function* () {
        let destination = manifestUrl;
        for (let attempt = 0; attempt < maximumRequests; attempt += 1) {
          const response = yield* http
            .execute(HttpClientRequest.get(destination), maximumResponseBytes)
            .pipe(
              Effect.provideService(FetchHttpClient.RequestInit, {
                credentials: "omit",
                redirect: "manual",
              })
            );
          if (response.status < redirectStatus || response.status >= clientErrorStatus) {
            return { ...response, headers: {} };
          }
          const redirect = response.headers["location"];
          if (redirect === undefined || redirect.length === 0) return yield* unavailable();
          const url = yield* Effect.try({
            try: () => new URL(redirect, destination),
            catch: unavailable,
          });
          if (!allowedRedirect(url)) return yield* unavailable();
          destination = url.href;
        }
        return yield* unavailable();
      }),
  };
};
