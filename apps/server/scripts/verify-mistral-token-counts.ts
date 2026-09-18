import { Console, Effect } from "effect";
import { verifyMistralTokenConformance } from "~/shell/hosted-inference/mistral-conformance-runtime";
import { MistralOutboundHttpFetchLive } from "~/shell/outbound-http/runtime";

const program = Effect.gen(function* () {
  const reports = yield* verifyMistralTokenConformance;
  for (const report of reports) yield* Console.log(report);
}).pipe(
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(MistralOutboundHttpFetchLive),
  Effect.catchCause(() =>
    Console.error(
      "Mistral token conformance failed; no request or response content was logged"
    ).pipe(Effect.andThen(Effect.fail("mistral_conformance_failed")))
  )
);

await Effect.runPromise(program);
