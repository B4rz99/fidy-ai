import { admitResourceWithAttemptPressure } from "../../resource-admission/operations";
import { Data, Effect, Option } from "effect";
import {
  HostedInferenceError,
  type WorkersAiBindingRun,
} from "../../../src/shell/hosted-inference/contract";
import type { TranscriptTurnId } from "../../../src/core/agent/contract";
import { withConsentEgress } from "../../consent/operations";
import { spendRequest, workersAiPolicies } from "./admission-policy";
import {
  ResourceAdmissionEpochMs,
  ResourceAdmissionRefused,
  ResourceAdmissionUnits,
} from "../../resource-admission/contract";

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
    const authority = {
      database: db,
      nowEpochMs: (): ResourceAdmissionEpochMs => current,
      policies: workersAiPolicies,
    };
    const cost = ResourceAdmissionUnits.make(
      new TextEncoder().encode(JSON.stringify(request)).length + request.max_tokens
    );
    return Effect.runPromise(
      admitResourceWithAttemptPressure(authority, spendRequest({ userId, cost })).pipe(
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
