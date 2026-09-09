import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

/** Internal stop signal; provider adapters classify it safely while the runner observes exhaustion. */
class EvaluationRequestBudgetExceeded extends Data.TaggedError(
  "EvaluationRequestBudgetExceeded"
)<{}> {}

export type EvaluationRequestBudgetService = Readonly<{
  count: Effect.Effect<number>;
  rejected: Effect.Effect<number>;
  exhausted: Effect.Effect<boolean>;
  inputTokens: Effect.Effect<number>;
  cachedInputTokens: Effect.Effect<number>;
  outputTokens: Effect.Effect<number>;
  observedModels: Effect.Effect<ReadonlyArray<string>>;
}>;

const ResponseUsage = Schema.Struct({
  model: Schema.String,
  usage: Schema.Struct({
    input_tokens: Schema.Int,
    output_tokens: Schema.Int,
    input_tokens_details: Schema.optionalKey(Schema.Struct({ cached_tokens: Schema.Int })),
  }),
});
type ProviderObservations = {
  usage: { input: number; cachedInput: number; output: number };
  models: Set<string>;
};

const observeProviderResponse = (
  response: Response,
  pathname: string,
  observations: ProviderObservations
): Promise<Response> => {
  process.stderr.write(`Evaluation provider request: ${pathname} -> ${response.status}.\n`);
  if (!response.ok || !pathname.endsWith("/responses")) return Promise.resolve(response);
  return response
    .clone()
    .json()
    .then(Schema.decodeUnknownOption(ResponseUsage), Option.none)
    .then((decoded) => {
      if (Option.isSome(decoded)) {
        observations.models.add(decoded.value.model);
        observations.usage.input += decoded.value.usage.input_tokens;
        observations.usage.cachedInput +=
          decoded.value.usage.input_tokens_details?.cached_tokens ?? 0;
        observations.usage.output += decoded.value.usage.output_tokens;
        process.stderr.write(
          `Evaluation provider usage: input=${decoded.value.usage.input_tokens}, ` +
            `cached=${decoded.value.usage.input_tokens_details?.cached_tokens ?? 0}, ` +
            `output=${decoded.value.usage.output_tokens}.\n`
        );
      }
      return response;
    });
};

/** Counts and limits only OpenAI requests; local API traffic is outside provider spend admission. */
export class EvaluationRequestBudget extends Context.Service<
  EvaluationRequestBudget,
  EvaluationRequestBudgetService
>()("@fidy/server/shell/testing/evaluation/request-budget/EvaluationRequestBudget") {}

/** Installs the actual fetch implementation used below production provider HTTP policies. */
export const requestBudgetLayer = (
  maximumRequests: number
): Layer.Layer<EvaluationRequestBudget | (typeof FetchHttpClient.Fetch)["Identifier"]> =>
  Layer.syncContext(() => {
    let count = 0;
    let rejected = 0;
    const observations: ProviderObservations = {
      usage: { input: 0, cachedInput: 0, output: 0 },
      models: new Set<string>(),
    };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const budgetedFetch: typeof globalThis.fetch = Object.assign(
      (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1]
      ) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith("https://api.openai.com/")) return nativeFetch(input, init);
        count += 1;
        if (count > maximumRequests) {
          rejected += 1;
          return Promise.reject(new EvaluationRequestBudgetExceeded());
        }
        return nativeFetch(input, init).then((response) =>
          observeProviderResponse(response, new URL(url).pathname, observations)
        );
      },
      { preconnect: globalThis.fetch.preconnect }
    );
    return Context.make(FetchHttpClient.Fetch, budgetedFetch).pipe(
      Context.add(EvaluationRequestBudget, {
        count: Effect.sync(() => count),
        rejected: Effect.sync(() => rejected),
        exhausted: Effect.sync(() => rejected > 0),
        inputTokens: Effect.sync(() => observations.usage.input),
        cachedInputTokens: Effect.sync(() => observations.usage.cachedInput),
        outputTokens: Effect.sync(() => observations.usage.output),
        observedModels: Effect.sync(() => [...observations.models].toSorted()),
      })
    );
  });
