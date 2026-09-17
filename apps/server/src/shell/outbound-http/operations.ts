import { Config, Context, Effect, Layer } from "effect";
import { HttpClient } from "effect/unstable/http";
import { makeOutboundHttp } from "~/shell/outbound-http/internal/outbound-http";
import type { OutboundHttpFailure, OutboundHttpRequest, OutboundHttpResponse } from "./contract";

/**
 * Executes a request through its closed provider destination policy. Callers provide no URL,
 * credential, headers, redirect choice, tracing choice, or byte limit and receive only bounded
 * response bytes, explicitly retained headers, or a coordinate-free failure.
 */
export type OutboundHttpService = Readonly<{
  readonly execute: (
    request: OutboundHttpRequest
  ) => Effect.Effect<OutboundHttpResponse, OutboundHttpFailure>;
}>;

/** Authority to reach an external provider through the published Outbound HTTP policy. */
export class OutboundHttp extends Context.Service<OutboundHttp, OutboundHttpService>()(
  "@fidy/server/shell/outbound-http/operations/OutboundHttp"
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const kapsoApiKey = yield* Config.redacted("KAPSO_API_KEY");
      const httpClient = yield* HttpClient.HttpClient;
      return makeOutboundHttp({ kapsoApiKey, httpClient });
    })
  );
}
