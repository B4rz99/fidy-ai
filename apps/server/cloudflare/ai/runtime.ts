import { WorkersAiAdmissionUnavailable, type WorkersAiEnvironment } from "./contract";
import { makeAdmittedWorkersAiRun } from "./internal/admitted-run";
import { HostedInference } from "../../src/shell/hosted-inference/operations";
import { makeWorkersAiHostedInference } from "../../src/shell/hosted-inference/runtime";
import { Context, Effect, Layer, Option, type Scope } from "effect";
import type { TranscriptTurnId } from "../../src/core/agent/contract";
import { cloudflareWorkerTelemetry, observeModelRun } from "../runtime/telemetry/operations";
import { sweepExpiredWorkersAiAdmission as expireAdmission } from "./internal/admission-retention";
import {
  type HostedInferenceError,
  type HostedInferenceService,
  type WorkersAiRun,
} from "../../src/shell/hosted-inference/contract";

const observedWorkersAiRun =
  ({
    environment,
    ai,
  }: Readonly<{
    environment: WorkersAiEnvironment;
    ai: WorkersAiEnvironment["AI"];
  }>): WorkersAiRun =>
  (model, request) =>
    Effect.gen(function* () {
      const parent = yield* cloudflareWorkerTelemetry.captureDurableContext;
      return yield* Effect.tryPromise((signal) =>
        observeModelRun(() => ai.run(model, request, { returnRawResponse: true, signal }), {
          environment,
          telemetry: cloudflareWorkerTelemetry,
          parent: Option.getOrUndefined(parent),
        })
      );
    });

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
      const run = observedWorkersAiRun({ environment, ai });
      return admission === undefined ? run : makeAdmittedWorkersAiRun({ ...admission, run });
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
  Layer.build(cloudflareHostedInferenceLive(input)).pipe(
    Effect.option,
    Effect.map(Option.map((services) => Context.get(services, HostedInference)))
  );

/** Reclaim fixed-policy expired AI admission evidence without exposing spend or inference authority. */
export const sweepExpiredWorkersAiAdmission = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, WorkersAiAdmissionUnavailable> =>
  expireAdmission(input).pipe(Effect.mapError(() => new WorkersAiAdmissionUnavailable()));
