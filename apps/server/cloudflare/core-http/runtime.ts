import { Effect, Option } from "effect";
import type { TelemetryService } from "@fidy/server/telemetry";
import type { CoreHttpHandler } from "./contract";
import { acceptedWorkPublisher, executeCoreHttp } from "./internal/http";
import { observeWorkerRequest } from "../runtime/telemetry";

/** Construct private HTTP assembly with one bounded Work span and post-commit publication lifetime. */
export const makeCoreHttp =
  (telemetry: TelemetryService): CoreHttpHandler =>
  (request, environment, context) =>
    executeCoreHttp({
      request,
      environment,
      telemetry,
      publish: acceptedWorkPublisher(environment, Option.fromUndefinedOr(context)),
    }).pipe(
      observeWorkerRequest({ environment, telemetry, operation: "worker.core.fetch" }),
      Effect.runPromise
    );
