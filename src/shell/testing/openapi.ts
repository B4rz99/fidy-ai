import { expect } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import { AgentScope } from "~/core/tokens/model";
import { okStatus } from "~/shell/_shared/http-status";
import {
  AgentConfirmation,
  CanonicalOperationKind,
  OperationCostClass,
  OperationTier,
} from "~/shell/_shared/operation-policy";

const SpecOperation = Schema.Struct({
  operationId: Schema.String,
  description: Schema.optional(Schema.String),
  "x-fidy-required-scope": Schema.optional(AgentScope),
  "x-fidy-required-tier": Schema.optional(OperationTier),
  "x-fidy-cost-class": Schema.optional(OperationCostClass),
  "x-fidy-agent-confirmation": Schema.optional(AgentConfirmation),
  "x-fidy-operation-kind": Schema.optional(CanonicalOperationKind),
});

const OpenApiPaths = Schema.Struct({
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, SpecOperation)),
});

const publishedSpec = Effect.gen(function* () {
  const response = yield* HttpClient.get("/openapi.json");
  expect(response.status).toBe(okStatus);

  return yield* response.json;
});

/** One canonical operation, as the spec presents it to a calling agent. */
export type PublishedOperation = {
  readonly id: string;
  /** `None` when the spec carries no `description` at all for this operation. */
  readonly description: Option.Option<string>;
  /** `None` when the spec omits the canonical operation's required-scope metadata. */
  readonly requiredScope: Option.Option<AgentScope>;
  /** `None` when the spec omits the canonical operation's required-tier metadata. */
  readonly requiredTier: Option.Option<OperationTier>;
  /** `None` when the spec omits the canonical operation's cost-class metadata. */
  readonly costClass: Option.Option<OperationCostClass>;
  /** `None` when the spec omits the hosted-agent confirmation metadata. */
  readonly agentConfirmation: Option.Option<AgentConfirmation>;
  /** `None` when the spec omits the canonical operation kind metadata. */
  readonly kind: Option.Option<CanonicalOperationKind>;
};

/**
 * Every canonical operation the running server actually publishes, read back
 * out of the derived spec. Tests that assert against a canonical operation ask
 * the generators rather than a hand-kept list, so a new operation is covered
 * without anyone remembering.
 */
export const publishedOperations = Effect.gen(function* () {
  const spec = yield* Schema.decodeUnknownEffect(OpenApiPaths)(yield* publishedSpec);

  const operations: ReadonlyArray<PublishedOperation> = Object.values(spec.paths).flatMap(
    (methods) =>
      Object.values(methods).map(
        (operation): PublishedOperation => ({
          id: operation.operationId,
          description: Option.fromUndefinedOr(operation.description),
          requiredScope: Option.fromUndefinedOr(operation["x-fidy-required-scope"]),
          requiredTier: Option.fromUndefinedOr(operation["x-fidy-required-tier"]),
          costClass: Option.fromUndefinedOr(operation["x-fidy-cost-class"]),
          agentConfirmation: Option.fromUndefinedOr(operation["x-fidy-agent-confirmation"]),
          kind: Option.fromUndefinedOr(operation["x-fidy-operation-kind"]),
        })
      )
  );

  return operations;
});

/** The same enumeration, for tests that only need to name the operations. */
export const publishedOperationIds = publishedOperations.pipe(
  Effect.map((operations): ReadonlyArray<string> => operations.map((operation) => operation.id))
);
