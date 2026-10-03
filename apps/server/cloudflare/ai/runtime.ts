import { WorkersAiAdmissionUnavailable, type WorkersAiEnvironment } from "./contract";
import { makeAdmittedWorkersAiRun } from "./internal/admitted-run";
import { HostedInference } from "../../src/shell/hosted-inference/operations";
import { makeWorkersAiHostedInference } from "../../src/shell/hosted-inference/runtime";
import { Context, Effect, Exit, Layer, Option, type Scope } from "effect";
import type { TranscriptTurnId } from "../../src/core/agent/contract";
import { cloudflareWorkerTelemetry, observeModelRun } from "../runtime/telemetry/operations";
import { sweepExpiredWorkersAiAdmission as expireAdmission } from "./internal/admission-retention";
import {
  type HostedInferenceError,
  type HostedInferenceService,
  type WorkersAiBindingRun,
} from "../../src/shell/hosted-inference/contract";

/**
 * Builds hosted inference from the direct native binding. Missing binding or model configuration
 * fails before authority is returned; the wrapper always requests a bounded raw response and passes
 * Effect interruption to Cloudflare.
 */
const constructInference = (
  environment: WorkersAiEnvironment,
  admission?: Readonly<{
    db: D1Database;
    userId: string;
    admittedTurnId: () => Option.Option<TranscriptTurnId>;
  }>
): Effect.Effect<HostedInferenceService, HostedInferenceError> => {
  const binding = Option.fromNullishOr(environment.AI);
  return makeWorkersAiHostedInference({
    model: Option.fromNullishOr(environment.HOSTED_AI_MODEL),
    run: Option.map(binding, (ai) => {
      const run: WorkersAiBindingRun = (model, request, options) =>
        observeModelRun(
          () =>
            ai.run(model, request, {
              returnRawResponse: options.returnRawResponse,
              signal: options.signal,
            }),
          { environment, telemetry: cloudflareWorkerTelemetry }
        );
      return admission === undefined
        ? run
        : makeAdmittedWorkersAiRun({ ...admission, run, nowEpochMs: Date.now });
    }),
  });
};

/** Unmetered inference exists only for the private provider-conformance fixture. */
export const makeCloudflareHostedInference = (
  environment: WorkersAiEnvironment
): Effect.Effect<HostedInferenceService, HostedInferenceError> => constructInference(environment);

/** Production inference rechecks User-owned Consent and spend authority at every provider egress. */
export const makeUserCloudflareHostedInference = ({
  environment,
  db,
  userId,
  admittedTurnId,
}: Readonly<{
  environment: WorkersAiEnvironment;
  db: D1Database;
  userId: string;
  admittedTurnId: () => Option.Option<TranscriptTurnId>;
}>): Effect.Effect<HostedInferenceService, HostedInferenceError> =>
  constructInference(environment, { db, userId, admittedTurnId });

/** Cloudflare-configured production composition for Memory and hosted Turns. */
export const cloudflareHostedInferenceLive = ({
  environment,
  db,
  userId,
  admittedTurnId,
}: Readonly<{
  environment: WorkersAiEnvironment;
  db: D1Database;
  userId: string;
  admittedTurnId: () => Option.Option<TranscriptTurnId>;
}>): Layer.Layer<HostedInference, HostedInferenceError> =>
  HostedInference.layer(
    makeUserCloudflareHostedInference({ environment, db, userId, admittedTurnId })
  );

/**
 * Construct only the inference consumed by this workload. Missing or unusable binding yields None,
 * allowing unrelated canonical owners to remain available; User egress and spend checks remain live.
 */
export const optionalHostedInference = (
  input: Parameters<typeof cloudflareHostedInferenceLive>[0]
): Effect.Effect<Option.Option<HostedInferenceService>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const built = yield* Effect.exit(Layer.build(cloudflareHostedInferenceLive(input)));
    return Exit.isFailure(built)
      ? Option.none()
      : Option.some(Context.get(built.value, HostedInference));
  });

/** Reclaim fixed-policy expired AI admission evidence without exposing spend or inference authority. */
export const sweepExpiredWorkersAiAdmission = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, WorkersAiAdmissionUnavailable> =>
  expireAdmission(input).pipe(Effect.mapError(() => new WorkersAiAdmissionUnavailable()));
