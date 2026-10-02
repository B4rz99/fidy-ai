import { Context, Effect, Layer } from "effect";
import type {
  HostedConformanceCheck,
  HostedConformanceFailure,
  HostedInferenceError,
  HostedInferenceService,
  HostedInferenceStubBehavior,
} from "./contract";
import {
  verifyCanonicalMutation,
  verifyCanonicalQuery,
  verifyInvalidOutputRecovery,
  verifyMutationMoney,
  verifyMutationTime,
  verifyStructuredColombianSpanish,
} from "~/shell/hosted-inference/internal/conformance";
import { makeHostedInferenceStubInternal } from "~/shell/hosted-inference/internal/stub";

/** Hosted inference authority supplied by the Cloudflare Workers AI adapter. */
export class HostedInference extends Context.Service<HostedInference, HostedInferenceService>()(
  "@fidy/server/shell/hosted-inference/operations/HostedInference"
) {
  static readonly layer = <Error, Requirements>(
    service: Effect.Effect<HostedInferenceService, Error, Requirements>
  ): Layer.Layer<HostedInference, Error, Requirements> => Layer.effect(this, service);
}

/** Builds deterministic hosted inference without exposing adapters or provider prompts. */
export const makeHostedInferenceStub = (
  behavior: HostedInferenceStubBehavior
): HostedInferenceService => makeHostedInferenceStubInternal(behavior);

/** Evaluate a live model candidate; return no generated content, only closed failure evidence. */
export const verifyHostedInferenceConformanceChecks = (
  inference: HostedInferenceService
): Effect.Effect<void, HostedConformanceFailure> => {
  const check = <A>(
    name: HostedConformanceCheck,
    work: Effect.Effect<A, HostedInferenceError>
  ): Effect.Effect<A, HostedConformanceFailure> =>
    work.pipe(
      Effect.mapError((error): HostedConformanceFailure => ({
        check: name,
        category: error.reason._tag,
      }))
    );
  return check("canonical_query", verifyCanonicalQuery(inference)).pipe(
    Effect.andThen(check("canonical_mutation", verifyCanonicalMutation(inference))),
    Effect.flatMap((args) =>
      check("canonical_mutation_money", verifyMutationMoney(args)).pipe(
        Effect.andThen(check("canonical_mutation_time", verifyMutationTime(args)))
      )
    ),
    Effect.andThen(check("invalid_output_recovery", verifyInvalidOutputRecovery(inference))),
    Effect.andThen(check("structured_es_co", verifyStructuredColombianSpanish(inference)))
  );
};
