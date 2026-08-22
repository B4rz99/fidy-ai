import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { StartedBrowserLoginPairing } from "~/core/browser-login/model";
import { BrowserLoginRateLimitedApi, BrowserLoginUnavailableApi } from "./errors";

export const BrowserLoginWebAuthGroup = HttpApiGroup.make("browserLogin").add(
  HttpApiEndpoint.post("startPairing", "/web-auth/pairings", {
    success: StartedBrowserLoginPairing,
    error: [BrowserLoginRateLimitedApi, BrowserLoginUnavailableApi],
  }).annotate(
    OpenApi.Description,
    "Create one short-lived browser login pairing and return its private verifier once."
  )
);

/** Direct browser authentication API. Secret-bearing responses never enter the canonical API. */
export class WebAuthApi extends HttpApi.make("webAuth")
  .add(BrowserLoginWebAuthGroup)
  .annotate(OpenApi.Title, "fidy-ai WebAuth API") {}
