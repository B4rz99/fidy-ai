import { Effect, Layer, Option } from "effect";
import {
  OutboundHttpFailure,
  type OutboundHttpRequest,
  type OutboundHttpResponse,
} from "~/shell/outbound-http/contract";
import { OutboundHttp, type OutboundHttpService } from "~/shell/outbound-http/operations";

/** Converts a Web response into the bounded-response shape used by provider-adapter test doubles. */
export const testOutboundHttpResponse = (
  response: Response
): Effect.Effect<OutboundHttpResponse, OutboundHttpFailure> =>
  Effect.tryPromise({
    try: () => response.arrayBuffer(),
    catch: () =>
      new OutboundHttpFailure({
        reason: "response-body-failed",
        responseStatus: Option.none(),
        responseHeaders: {},
      }),
  }).pipe(
    Effect.map((body) => ({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: new Uint8Array(body),
    }))
  );

/** Published-authority test double for provider adapters; transport tests stay with Outbound HTTP. */
export const makeTestOutboundHttp = (
  respond: (request: OutboundHttpRequest) => Effect.Effect<Response, OutboundHttpFailure>
): OutboundHttpService => ({
  execute: (request) => respond(request).pipe(Effect.flatMap(testOutboundHttpResponse)),
});

export const testOutboundHttpLayer = (
  respond: (request: OutboundHttpRequest) => Effect.Effect<Response, OutboundHttpFailure>
): Layer.Layer<OutboundHttp> => Layer.succeed(OutboundHttp, makeTestOutboundHttp(respond));
