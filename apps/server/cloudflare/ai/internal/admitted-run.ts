import { admitResourceWithAttemptPressure } from "../../resource-admission/operations";
import { Cause, Clock, Effect, Option, Schema } from "effect";
import {
  HostedInferenceError,
  type WorkersAiRun,
} from "../../../src/shell/hosted-inference/contract";
import type { TranscriptTurnId } from "../../../src/core/agent/contract";
import { withConsentEgress } from "../../consent/operations";
import { spendRequest, workersAiPolicies } from "./admission-policy";
import {
  ResourceAdmissionEpochMs,
  ResourceAdmissionRefused,
  ResourceAdmissionUnits,
} from "../../resource-admission/contract";

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
    admittedTurnId,
  }: Readonly<{
    db: D1Database;
    userId: string;
    run: WorkersAiRun;
    admittedTurnId: () => Option.Option<TranscriptTurnId>;
  }>): WorkersAiRun =>
  (model, request) =>
    Effect.gen(function* () {
      const current = ResourceAdmissionEpochMs.make(yield* Clock.currentTimeMillis);
      const authority = {
        database: db,
        nowEpochMs: (): ResourceAdmissionEpochMs => current,
        policies: workersAiPolicies,
      };
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        request
      ).pipe(Effect.mapError(inferenceAdmissionFailure));
      const cost = ResourceAdmissionUnits.make(
        new TextEncoder().encode(encoded).length + request.max_tokens
      );
      return yield* admitResourceWithAttemptPressure(
        authority,
        spendRequest({ userId, cost })
      ).pipe(
        Effect.mapError(inferenceAdmissionFailure),
        Effect.flatMap(() =>
          withConsentEgress({
            db,
            userId,
            admittedTurnId: admittedTurnId(),
            action: run(model, request),
          }).pipe(
            Effect.mapError((failure) =>
              failure instanceof HostedInferenceError || failure instanceof Cause.UnknownError
                ? failure
                : inferenceAdmissionFailure(failure)
            )
          )
        )
      );
    });
