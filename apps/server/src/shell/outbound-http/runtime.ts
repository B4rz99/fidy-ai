import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { OutboundHttp } from "./operations";

/** Production fetch transport published only for composition with policy-bearing Outbound layers. */
export const OutboundHttpFetchTransportLive = FetchHttpClient.layer;

/** Production Outbound HTTP construction published for application runtime composition. */
export const OutboundHttpLive = OutboundHttp.layer;

/** Standalone production composition for commands that do not provide the server's Bun client. */
export const OutboundHttpFetchLive = OutboundHttp.layer.pipe(
  Layer.provide(OutboundHttpFetchTransportLive)
);

/** Provider-specific production compositions for bounded operational commands. */
export const MistralOutboundHttpFetchLive = OutboundHttp.mistralLayer.pipe(
  Layer.provide(OutboundHttpFetchTransportLive)
);
export const SentryOutboundHttpFetchLive = OutboundHttp.sentryLayer.pipe(
  Layer.provide(OutboundHttpFetchTransportLive)
);
