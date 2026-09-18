import { Console, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { verifyMistralTokenConformance } from "~/shell/agent/mistral-conformance";
import { OutboundHttp } from "~/shell/outbound-http/operations";

const program = Effect.gen(function* () {
  const reports = yield* verifyMistralTokenConformance;
  for (const report of reports) yield* Console.log(report);
}).pipe(
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(OutboundHttp.mistralLayer.pipe(Layer.provide(FetchHttpClient.layer))),
  Effect.catchCause(() =>
    Console.error(
      "Mistral token conformance failed; no request or response content was logged"
    ).pipe(Effect.andThen(Effect.fail("mistral_conformance_failed")))
  )
);

await Effect.runPromise(program);
