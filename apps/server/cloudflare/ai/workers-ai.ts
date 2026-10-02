import type { WorkersAiEnvironment } from "./contract";
import { spendRequest, workersAiPolicies } from "./internal/admission-policy";
import {
  HostedInference,
  HostedInferenceError,
  type HostedInferenceService,
  type WorkersAiBindingRun,
  makeWorkersAiHostedInference,
} from "@fidy/server/hosted-inference";
import { Context, Data, Effect, Exit, Layer, Option, type Scope } from "effect";
import type { TranscriptTurnId } from "@fidy/server/agent-contract";
import { withConsentEgress } from "../consent/operations";
import { cloudflareWorkerTelemetry, observeModelRun } from "../runtime/telemetry";
import {
  ResourceAdmissionAuthority,
  ResourceAdmissionEpochMs,
  ResourceAdmissionRefused,
  ResourceAdmissionUnits,
} from "../resource-admission/authority";

class WorkersAiBindingFailure extends Data.TaggedError("WorkersAiBindingFailure")<{
  readonly cause: unknown;
}> {}

const inferenceAdmissionFailure = (failure: unknown): HostedInferenceError =>
  new HostedInferenceError({
    reason: {
      _tag: failure instanceof ResourceAdmissionRefused ? "ResourceLimit" : "AdmissionUnavailable",
    },
    retryable: false,
    retryAfter: Option.none(),
  });

/**
 * Recheck the User's Consent purpose immediately before every provider call and reserve the maximum
 * token proxy even on failure. Only an exact, still-Pending admitted Turn can retain its accepted
 * Consent basis after revocation; preflight and standalone work require current standing.
 */
export const makeAdmittedWorkersAiRun =
  ({
    db,
    userId,
    run,
    nowEpochMs,
    admittedTurnId,
  }: Readonly<{
    db: D1Database;
    userId: string;
    run: WorkersAiBindingRun;
    nowEpochMs: () => number;
    admittedTurnId: () => Option.Option<TranscriptTurnId>;
  }>): WorkersAiBindingRun =>
  (model, request, options) => {
    const current = ResourceAdmissionEpochMs.make(nowEpochMs());
    const authority = ResourceAdmissionAuthority.make({
      database: db,
      nowEpochMs: () => current,
      policies: workersAiPolicies,
    });
    const cost = ResourceAdmissionUnits.make(
      new TextEncoder().encode(JSON.stringify(request)).length + request.max_tokens
    );
    return Effect.runPromise(
      authority.admitWithAttemptPressure(spendRequest({ userId, cost })).pipe(
        Effect.mapError(inferenceAdmissionFailure),
        Effect.flatMap(() =>
          withConsentEgress({
            db,
            userId,
            admittedTurnId: admittedTurnId(),
            action: Effect.tryPromise({
              try: () => run(model, request, options),
              catch: (cause) => new WorkersAiBindingFailure({ cause }),
            }),
          }).pipe(
            Effect.mapError((failure) =>
              failure instanceof WorkersAiBindingFailure
                ? failure
                : inferenceAdmissionFailure(failure)
            )
          )
        )
      )
    ).catch((failure: unknown) => {
      throw failure instanceof WorkersAiBindingFailure ? failure.cause : failure;
    });
  };

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
