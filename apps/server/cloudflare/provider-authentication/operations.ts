import { providerStatus } from "./internal/status";
import { completeProvider } from "./internal/completion";
import { providerCallback } from "./internal/callback";
import type { HttpClient } from "effect/http";

import { Effect } from "effect";
import {
  microsoftProviderPaths,
  providerPaths,
} from "../../src/shell/provider-authentication/contract";
import { webSignupDisclosure } from "../../src/shell/consent/operations";
import type { ProviderCompletionRequest, ProviderEnvironment } from "./contract";
import { providerJson, startProvider } from "./internal/start";

const invalidStatus = 400;
/** Recognize the fixed first-party provider protocol surface; matching grants no authority. */
export const ownsProviderAuthenticationPath = (path: string): boolean =>
  [...Object.values(providerPaths), ...Object.values(microsoftProviderPaths)].some(
    (owned) => owned === path
  );
const providerGet = ({
  request,
  environment,
}: Readonly<{ request: Request; environment: ProviderEnvironment }>): Effect.Effect<
  Response,
  never,
  HttpClient.HttpClient
> => {
  const path = new URL(request.url).pathname;
  if (path === providerPaths.disclosure) {
    const { revision, text } = webSignupDisclosure();
    return Effect.succeed(providerJson({ body: { revision, text } }));
  }
  if (path === microsoftProviderPaths.callback) {
    return providerCallback({ request, environment, provider: "microsoft" });
  }
  return path === providerPaths.callback
    ? providerCallback({ request, environment, provider: "google" })
    : Effect.succeed(providerJson({ body: { status: "invalid" }, status: invalidStatus }));
};
/** Execute the owner-validated browser-bound provider flow; this owner never issues a WebSession. */
export const handleProviderAuthentication = ({
  request,
  environment,
}: Readonly<{ request: Request; environment: ProviderEnvironment }>): Effect.Effect<
  Response,
  never,
  HttpClient.HttpClient
> => {
  const path = new URL(request.url).pathname;
  if (request.method === "GET") return providerGet({ request, environment });
  if (request.method !== "POST") {
    return Effect.succeed(providerJson({ body: { status: "invalid" }, status: invalidStatus }));
  }
  if (path === providerPaths.status) {
    return providerStatus({ request, environment, provider: "google" });
  }
  if (path === microsoftProviderPaths.status) {
    return providerStatus({ request, environment, provider: "microsoft" });
  }
  if (path === providerPaths.start) {
    return startProvider({ request, environment, provider: "google" });
  }
  if (path === microsoftProviderPaths.start) {
    return startProvider({ request, environment, provider: "microsoft" });
  }
  return Effect.succeed(providerJson({ body: { status: "invalid" }, status: invalidStatus }));
};

/** Verify the initiating browser and exact validated provider attempt before atomic signup or returning-User pairing approval. No session or reusable provider authority is returned. */
export const completeProviderAuthentication = (
  input: ProviderCompletionRequest
): Promise<Response> => completeProvider(input);
