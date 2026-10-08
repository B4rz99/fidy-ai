import { FetchHttpClient, HttpClient } from "effect/http";
import { Context, Effect, Layer, Option } from "effect";
import type { TelemetryService } from "../../src/shell/observability/contract";
import type { CoreHttpHandler } from "./contract";
import { acceptedWorkPublisher, executeCoreHttp } from "./internal/http";
import { observeWorkerRequest } from "../runtime/telemetry/operations";

/** Construct private HTTP assembly with one bounded Work span and post-commit publication lifetime. */
export const makeCoreHttp =
  (telemetry: TelemetryService): CoreHttpHandler =>
  (request, environment, context) =>
    Effect.gen(function* () {
      const clients = yield* Layer.build(FetchHttpClient.layer).pipe(
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)
      );
      return yield* executeCoreHttp({
        request,
        environment,
        telemetry,
        publish: acceptedWorkPublisher({ environment, context: Option.fromUndefinedOr(context) }),
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, Context.get(clients, HttpClient.HttpClient))
      );
    }).pipe(
      Effect.scoped,
      observeWorkerRequest({ environment, telemetry, operation: "worker.core.fetch" }),
      Effect.runPromise
    );
