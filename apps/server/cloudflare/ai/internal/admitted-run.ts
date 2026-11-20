import { admitResourceWithAttemptPressure } from "../../resource-admission/operations";
import { Cause, Clock, Effect, Option, Schema } from "effect";
import { HostedInferenceError, type OpenAiRun } from "../../../src/shell/hosted-inference/contract";
import type { TranscriptTurnId } from "../../../src/core/agent/contract";
import { withConsentEgress } from "../../consent/operations";
import { openAiPolicies, spendRequest } from "./admission-policy";
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

export const makeAdmittedOpenAiRun =
  ({
    db,
    userId,
    run,
    admittedTurnId,
  }: Readonly<{
    db: D1Database;
    userId: string;
    run: OpenAiRun;
    admittedTurnId: () => Option.Option<TranscriptTurnId>;
  }>): OpenAiRun =>
  (model, request) =>
    Effect.gen(function* () {
      const current = ResourceAdmissionEpochMs.make(yield* Clock.currentTimeMillis);
      const authority = {
        database: db,
        nowEpochMs: (): ResourceAdmissionEpochMs => current,
        policies: openAiPolicies,
      };
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        request
      ).pipe(Effect.mapError(inferenceAdmissionFailure));
      const cost = ResourceAdmissionUnits.make(
        new TextEncoder().encode(encoded).length + request.max_completion_tokens
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
