import { Context, Effect, type JsonSchema, Layer } from "effect";
import { operationCatalog } from "~/shell/api";
import { hostedOperationBindings } from "~/shell/canonical-operations/operations";
import { openAiProviderSchema } from "~/shell/hosted-inference/internal/provider-schema";
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
  verifyDateOnlyMutation,
  verifyInvalidOutputRecovery,
  verifyMutationMoney,
  verifyMutationTime,
  verifyRecurringLifecycle,
  verifyRecurringPlanRead,
  verifyStructuredColombianSpanish,
  verifyTransactionCorrection,
  verifyTransactionDeletion,
} from "~/shell/hosted-inference/internal/conformance";
import { makeHostedInferenceStubInternal } from "~/shell/hosted-inference/internal/stub";

/** Static build projection; live tool availability and input decoding retain canonical authority. */
export const makeHostedToolParameters = (): ReadonlyArray<
  Readonly<{ wireName: string; parameters: JsonSchema.JsonSchema }>
> =>
  hostedOperationBindings(operationCatalog).map(({ operation, wireName }) => ({
    wireName,
    parameters: openAiProviderSchema(operation.input),
  }));

/** Hosted inference authority supplied by the Cloudflare OpenAI adapter. */
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
  return check("canonical_recurring_read", verifyRecurringPlanRead(inference)).pipe(
    Effect.andThen(check("canonical_query", verifyCanonicalQuery(inference))),
    Effect.andThen(check("canonical_mutation", verifyCanonicalMutation(inference))),
    Effect.flatMap((args) =>
      check("canonical_mutation_money", verifyMutationMoney(args)).pipe(
        Effect.andThen(check("canonical_mutation_time", verifyMutationTime(args)))
      )
    ),
    Effect.andThen(check("canonical_correction", verifyTransactionCorrection(inference))),
    Effect.andThen(check("canonical_deletion", verifyTransactionDeletion(inference))),
    Effect.andThen(check("canonical_date_only", verifyDateOnlyMutation(inference))),
    Effect.andThen(check("canonical_recurring_lifecycle", verifyRecurringLifecycle(inference))),
    Effect.andThen(check("invalid_output_recovery", verifyInvalidOutputRecovery(inference))),
    Effect.andThen(check("structured_es_co", verifyStructuredColombianSpanish(inference)))
  );
};
