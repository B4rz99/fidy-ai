import { Context, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { OutboundHttpLive } from "../outbound-http/runtime";
import type { ErasureCandidateEnvironment } from "./contract";
import { handleErasureCandidateOperator } from "./runtime";

export { UserTransactionCoordinator } from "../transactions/runtime";

export default {
  fetch: (request: Request, environment: ErasureCandidateEnvironment): Promise<Response> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const clients = yield* Layer.build(OutboundHttpLive).pipe(
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)
        );
        return yield* handleErasureCandidateOperator({ request, environment }).pipe(
          Effect.provideService(HttpClient.HttpClient, Context.get(clients, HttpClient.HttpClient))
        );
      }).pipe(Effect.scoped),
      { signal: request.signal }
    ),
};
