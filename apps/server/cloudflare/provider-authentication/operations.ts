import { providerStatus } from "./internal/status";
import { completeProvider } from "./internal/completion";
import { googleCallback } from "./internal/callback";
import type { HttpClient } from "effect/http";

import { Effect } from "effect";
import { providerPaths } from "../../src/shell/provider-authentication/contract";
import { webSignupDisclosure } from "../../src/shell/consent/operations";
import type { GoogleEnvironment, ProviderCompletionRequest } from "./contract";
import { providerJson, startGoogle } from "./internal/start";

const invalidStatus = 400;
/** Recognize the fixed first-party Google protocol surface; matching grants no authority. */
export const ownsProviderAuthenticationPath = (path: string): boolean =>
  Object.values(providerPaths).some((owned) => owned === path);
const providerGet = ({
  request,
  environment,
}: Readonly<{ request: Request; environment: GoogleEnvironment }>): Effect.Effect<
  Response,
  never,
  HttpClient.HttpClient
> => {
  const path = new URL(request.url).pathname;
  if (path === providerPaths.disclosure) {
    const { revision, text } = webSignupDisclosure();
    return Effect.succeed(providerJson({ body: { revision, text } }));
  }
  return path === providerPaths.callback
    ? googleCallback({ request, environment })
    : Effect.succeed(providerJson({ body: { status: "invalid" }, status: invalidStatus }));
};
/** Execute the owner-validated browser-bound Google flow; this owner never issues a WebSession. */
export const handleProviderAuthentication = ({
  request,
  environment,
}: Readonly<{ request: Request; environment: GoogleEnvironment }>): Effect.Effect<
  Response,
  never,
  HttpClient.HttpClient
> => {
  const path = new URL(request.url).pathname;
  if (request.method === "GET") return providerGet({ request, environment });
  if (request.method !== "POST") {
    return Effect.succeed(providerJson({ body: { status: "invalid" }, status: invalidStatus }));
  }
  if (path === providerPaths.status) return providerStatus({ request, environment });
  if (path === providerPaths.start) return startGoogle({ request, environment });
  return Effect.succeed(providerJson({ body: { status: "invalid" }, status: invalidStatus }));
};

/** Verify the initiating browser and exact validated provider attempt before atomic signup or returning-User pairing approval. No session or reusable provider authority is returned. */
export const completeProviderAuthentication = (
  input: ProviderCompletionRequest
): Promise<Response> => completeProvider(input);
