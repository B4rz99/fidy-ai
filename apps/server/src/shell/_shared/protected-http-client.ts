import { Effect } from "effect";
import { Headers, HttpClient } from "effect/unstable/http";
import {
  type HttpClientErrorProjection,
  projectHttpClientError,
} from "./projected-http-client-error";

/** Explicit trace and credential policy one credentialed outbound HTTP client applies. */
export type ProtectedHttpClientPolicy = HttpClientErrorProjection &
  Readonly<{
    /** Credential and request-identity headers protected in addition to inherited names. */
    readonly redactedHeaders: ReadonlyArray<string>;
    /**
     * Whether Fidy trace coordinates may cross this boundary. It is an explicit per-client
     * decision, never ambient client behaviour, even though a suppressed automatic span means the
     * decision currently propagates nothing.
     */
    readonly propagateTrace: boolean;
  }>;

const excludeHttpHeaders = (): boolean => false;
// The automatic client span would carry the request coordinate (origin, port, path, query), so
// this shared policy never creates one. Adapters that need telemetry instrument their own bounded
// span over the exchange.
const suppressAutomaticSpan = (): boolean => true;

/**
 * Applies the shared hardening every credentialed outbound HTTP client owes before execution:
 * inherited plus configured header redactions, no automatic client span, an explicit trace
 * propagation decision, and coordinate-free failure projection.
 */
export const protectHttpClient =
  (policy: ProtectedHttpClientPolicy) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.transform(client, (requestEffect) =>
      Effect.gen(function* () {
        const inheritedRedactions = yield* Headers.CurrentRedactedNames;
        return yield* requestEffect.pipe(
          Effect.provideService(Headers.CurrentRedactedNames, [
            ...inheritedRedactions,
            ...policy.redactedHeaders,
          ]),
          Effect.provideService(HttpClient.TracerHeaderFilter, excludeHttpHeaders),
          Effect.provideService(HttpClient.TracerPropagationEnabled, policy.propagateTrace),
          Effect.provideService(HttpClient.TracerDisabledWhen, suppressAutomaticSpan),
          Effect.mapError(projectHttpClientError(policy))
        );
      })
    );
