import { Context, Effect, type JsonSchema, Layer } from "effect";
import { operationCatalog } from "~/shell/api";
import { hostedOperationBindings } from "~/shell/canonical-operations/operations";
import { openAiProviderSchema } from "~/shell/hosted-inference/internal/provider-schema";
import type {
  HostedConformanceCheck,
  HostedConformanceFailure,
  HostedInferenceError,
  HostedInferenceService,
} from "./contract";
import {
  verifyCanonicalMutation,
  verifyCanonicalQuery,
  verifyConversationalSpanish,
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

export const makeHostedToolParameters = (): ReadonlyArray<
  Readonly<{ wireName: string; parameters: JsonSchema.JsonSchema }>
> =>
  hostedOperationBindings(operationCatalog).map(({ operation, wireName }) => ({
    wireName,
    parameters: openAiProviderSchema(operation.input),
  }));

export class HostedInference extends Context.Service<HostedInference, HostedInferenceService>()(
  "@fidy/server/shell/hosted-inference/operations/HostedInference"
) {
  static readonly make = <Error, Requirements>(
    service: Effect.Effect<HostedInferenceService, Error, Requirements>
  ): Effect.Effect<HostedInferenceService, Error, Requirements> => service;

  static readonly layer = <Error, Requirements>(
    service: Effect.Effect<HostedInferenceService, Error, Requirements>
  ): Layer.Layer<HostedInference, Error, Requirements> => Layer.effect(this, this.make(service));
}

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
    Effect.andThen(check("structured_es_co", verifyStructuredColombianSpanish(inference))),
    Effect.andThen(check("conversational_es_co", verifyConversationalSpanish(inference)))
  );
};
