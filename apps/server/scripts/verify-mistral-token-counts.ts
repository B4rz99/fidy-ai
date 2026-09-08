import { Config, Console, Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { verifyMistralTokenConformance } from "~/shell/agent/mistral-conformance";

const program = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("MISTRAL_API_KEY");
  const reports = yield* verifyMistralTokenConformance(apiKey);
  for (const report of reports) yield* Console.log(report);
}).pipe(
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(FetchHttpClient.layer),
  Effect.catchCause(() =>
    Console.error(
      "Mistral token conformance failed; no request or response content was logged"
    ).pipe(Effect.andThen(Effect.fail("mistral_conformance_failed")))
  )
);

await Effect.runPromise(program);
