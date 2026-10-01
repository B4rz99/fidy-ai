import {
  HostedInference,
  HostedInferenceError,
  type HostedInferenceService,
  type WorkersAiBindingRun,
  makeWorkersAiHostedInference,
} from "@fidy/server/hosted-inference";
import { type Cause, Data, Effect, type Layer, Option } from "effect";
import type { TranscriptTurnId } from "@fidy/server/agent-runtime";
import { withConsentEgress } from "../consent/operations";
import { cloudflareWorkerTelemetry, observeModelRun } from "../runtime/telemetry";
import { newId } from "../pats/pat-shared";
import {
  type ResourceAdmissionAttempt,
  ResourceAdmissionAuthority,
  ResourceAdmissionCharges,
  ResourceAdmissionDurationMs,
  ResourceAdmissionEpochMs,
  ResourceAdmissionGrantId,
  ResourceAdmissionLimit,
  ResourceAdmissionPolicies,
  ResourceAdmissionPolicyKey,
  ResourceAdmissionRefused,
  ResourceAdmissionScopeKey,
  ResourceAdmissionUnits,
} from "../resource-admission/authority";

const millisecondsPerDay = 86_400_000;
const oneDay = ResourceAdmissionDurationMs.make(millisecondsPerDay);
const maximumUserAttempts = 500;
const maximumGlobalAttempts = 50_000;
const maximumUserSpend = 32_000_000;
const maximumGlobalSpend = 512_000_000;
const oneUnit = ResourceAdmissionUnits.make(1);
// Byte length conservatively bounds ordinary prompt tokens; output is reserved at max_tokens.
// These are resource-spend ceilings, never commercial Free allowances.
const workersAiPolicies = ResourceAdmissionPolicies.make([
  {
    dimension: "stable_user",
    durationMs: oneDay,
    key: ResourceAdmissionPolicyKey.make("workers-ai.attempt.user.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumUserAttempts),
  },
  {
    dimension: "operation",
    durationMs: oneDay,
    key: ResourceAdmissionPolicyKey.make("workers-ai.attempt.global.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumGlobalAttempts),
  },
  {
    dimension: "spend",
    durationMs: oneDay,
    key: ResourceAdmissionPolicyKey.make("workers-ai.spend.user.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumUserSpend),
  },
  {
    dimension: "spend",
    durationMs: oneDay,
    key: ResourceAdmissionPolicyKey.make("workers-ai.spend.global.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumGlobalSpend),
  },
]);

const spendRequest = (userId: string, cost: ResourceAdmissionUnits): ResourceAdmissionAttempt => ({
  attempt: {
    charges: ResourceAdmissionCharges.make([
      {
        policyKey: ResourceAdmissionPolicyKey.make("workers-ai.attempt.user.v1"),
        scopeKey: ResourceAdmissionScopeKey.make(userId),
        units: oneUnit,
      },
      {
        policyKey: ResourceAdmissionPolicyKey.make("workers-ai.attempt.global.v1"),
        scopeKey: ResourceAdmissionScopeKey.make("workers-ai"),
        units: oneUnit,
      },
    ]),
    grantId: ResourceAdmissionGrantId.make(`workers-ai-attempt-${newId()}`),
    statements: [],
  },
  work: {
    charges: ResourceAdmissionCharges.make([
      {
        policyKey: ResourceAdmissionPolicyKey.make("workers-ai.spend.user.v1"),
        scopeKey: ResourceAdmissionScopeKey.make(userId),
        units: cost,
      },
      {
        policyKey: ResourceAdmissionPolicyKey.make("workers-ai.spend.global.v1"),
        scopeKey: ResourceAdmissionScopeKey.make("workers-ai"),
        units: cost,
      },
    ]),
    grantId: ResourceAdmissionGrantId.make(`workers-ai-spend-${newId()}`),
    statements: [],
  },
});

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
      authority.admitWithAttemptPressure(spendRequest(userId, cost)).pipe(
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

/** Remove bounded expired AI admission evidence; never refund unexpired spend or retry grants. */
export const sweepExpiredWorkersAiAdmission = ({
  db,
  now,
}: Readonly<{ db: D1Database; now: number }>): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(
          `DELETE FROM resource_admission_events WHERE grant_id IN (
           SELECT id FROM resource_admission_grants
           WHERE id LIKE 'workers-ai-%' AND admitted_at_epoch_ms <= ?
           ORDER BY admitted_at_epoch_ms LIMIT 128
         ) AND expires_at_epoch_ms <= ?`
        )
        .bind(now - millisecondsPerDay, now),
      db
        .prepare(
          `DELETE FROM resource_admission_grants
         WHERE id LIKE 'workers-ai-%' AND admitted_at_epoch_ms <= ?
           AND NOT EXISTS (SELECT 1 FROM resource_admission_events e WHERE e.grant_id = id)`
        )
        .bind(now - millisecondsPerDay),
    ])
  ).pipe(Effect.asVoid);

/** Core bindings required to construct hosted inference without any external-model route. */
export type WorkersAiEnvironment = Readonly<{
  AI: Readonly<{ run: WorkersAiBindingRun }>;
  HOSTED_AI_MODEL: string;
}>;

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
