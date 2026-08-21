import { Crypto, Effect, Function, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { SqlClient } from "effect/unstable/sql";
import { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput";
import { type AgentConfirmation } from "~/shell/_shared/operation-policy";
import { operationCatalog } from "~/shell/api";
import type { CanonicalCaller } from "~/shell/_shared/authz";
import { Telemetry } from "~/shell/observability/telemetry";
import {
  CanonicalCallRejected,
  executeHostedCanonicalOperation,
  recordHostedPreflightRejection,
} from "~/shell/_shared/canonical-operation-executor";
import { canonicalJsonString } from "./canonical-json";
import type { CanonicalExecutionRequirements } from "~/shell/_shared/canonical-implementation";
import { HostedInference } from "./hosted-inference";
import type { ConfirmationPermit } from "./tool-confirmation-model";
import {
  type AgentOperationBinding,
  OpenAiToolName,
  encodeOpenAiToolName,
} from "./agent-operation-binding";

export {
  type AgentOperationBinding,
  OpenAiToolName,
  encodeOpenAiToolName,
} from "./agent-operation-binding";

/** Every hosted tool binding, derived from the assembled FidyApi catalog. */
export const agentOperationBindings: ReadonlyArray<AgentOperationBinding> =
  operationCatalog.operations.map((operation) => {
    const { codec: wireCodec, jsonSchema: wireJsonSchema } = toCodecOpenAI(operation.input);
    const wireParameters: Schema.Codec<unknown, unknown, never, never> = Schema.make(wireCodec.ast);
    const providerResponseParameters: Schema.Codec<unknown, unknown, never, never> = Schema.Union([
      wireParameters,
      operation.input,
    ]);
    return {
      operation: operation.id,
      wireName: encodeOpenAiToolName(operation.id),
      description: operation.description,
      canonicalParameters: operation.input,
      providerResponseParameters,
      wireJsonSchema,
      success: operation.success,
      failure: operation.failure,
      policy: operation.policy,
    };
  });

const bindingsByWireName = new Map(
  agentOperationBindings.map((binding) => [binding.wireName, binding] as const)
);
if (bindingsByWireName.size !== agentOperationBindings.length) {
  throw new Error("Canonical operation aliases must remain unique for OpenAI");
}

/** Finds the canonical binding for one provider-safe tool name. */
export const findAgentOperationBinding = (
  wireName: string
): Option.Option<AgentOperationBinding> =>
  Schema.is(OpenAiToolName)(wireName)
    ? Option.fromNullishOr(bindingsByWireName.get(wireName))
    : Option.none();

const confirmationGuidance = (agentConfirmation: AgentConfirmation): string =>
  agentConfirmation === "not-required"
    ? " This operation does not require User confirmation; call it directly without asking the User to confirm."
    : " The host manages exact confirmation for this operation; call the tool rather than asking the User for informal confirmation.";

/** Decodes a provider-safe tool input into the canonical operation input type. */
export const decodeAgentOperationInput: {
  (input: unknown): (self: AgentOperationBinding) => Effect.Effect<unknown, Schema.SchemaError>;
  (self: AgentOperationBinding, input: unknown): Effect.Effect<unknown, Schema.SchemaError>;
} = Function.dual(2, (self: AgentOperationBinding, input: unknown) =>
  Schema.decodeUnknownEffect(self.providerResponseParameters)(input)
);

/** Returns the complete provider-facing description, including required confirmation behavior. */
export const agentOperationToolDescription = (binding: AgentOperationBinding): string =>
  binding.description + confirmationGuidance(binding.policy.agentConfirmation);

const tools = agentOperationBindings.map((binding) =>
  Tool.dynamic(binding.wireName, {
    description: agentOperationToolDescription(binding),
    parameters: Schema.toEncoded(binding.canonicalParameters),
    success: binding.success,
    failure: binding.failure,
    failureMode: "return",
  })
);

/** Toolkit definition containing exactly the operations reflected from FidyApi. */
export const AgentToolkit = Toolkit.make(...tools);

export type AgentToolkitInstance = Toolkit.WithHandler<typeof AgentToolkit.tools> &
  Readonly<{
    prepare: (
      binding: AgentOperationBinding,
      canonicalInput: Schema.Json,
      permit: ConfirmationPermit
    ) => Effect.Effect<void, CanonicalCallRejected>;
    recordPreflightRejection: (binding: AgentOperationBinding) => Effect.Effect<void>;
  }>;

const isJsonInput = Schema.is(Schema.Json);

const permitKey = (binding: AgentOperationBinding, input: Schema.Json): string =>
  `${binding.operation}\n${canonicalJsonString(input)}`;

/**
 * Closure-owned queue of single-use confirmation permits keyed by exact operation and input. It is
 * never serialized, so an admitted permit cannot be replayed from outside its workflow.
 */
type PermitLedger = Readonly<{
  offer: (
    binding: AgentOperationBinding,
    canonicalInput: Schema.Json,
    permit: ConfirmationPermit
  ) => void;
  take: (binding: AgentOperationBinding, input: unknown) => Option.Option<ConfirmationPermit>;
}>;

const makePermitLedger = (): PermitLedger => {
  const permits = new Map<string, Array<ConfirmationPermit>>();
  const queueFor = (key: string): Array<ConfirmationPermit> =>
    Option.match(Option.fromUndefinedOr(permits.get(key)), {
      onNone: () => {
        const created: Array<ConfirmationPermit> = [];
        permits.set(key, created);
        return created;
      },
      onSome: (queued) => queued,
    });
  return {
    offer: (binding, canonicalInput, permit) => {
      queueFor(permitKey(binding, canonicalInput)).push(permit);
    },
    take: (binding, input) => {
      // A tool input JSON cannot represent has no canonical text, so it matches no permit and the
      // caller's refusal path records it like any other unmatched call.
      if (!isJsonInput(input)) return Option.none();
      const key = permitKey(binding, input);
      const queued = queueFor(key);
      const permit = Option.fromUndefinedOr(queued.shift());
      if (queued.length === 0) permits.delete(key);
      return permit;
    },
  };
};

/**
 * Everything hosted canonical execution requires. A handler must provide all of it: the AI SDK
 * invokes handlers wherever the model runs, so an ambient service is not a guarantee.
 */
type HostedExecutionRequirements = CanonicalExecutionRequirements;

/** Spends the prepared permit this exact call was issued, or refuses the call with evidence. */
const spendPermit = (input: {
  readonly caller: CanonicalCaller;
  readonly isExecutionActive: () => boolean;
  readonly ledger: PermitLedger;
  readonly binding: AgentOperationBinding;
  readonly untrustedInput: unknown;
}): Effect.Effect<unknown, object, HostedExecutionRequirements> =>
  Option.match(input.ledger.take(input.binding, input.untrustedInput), {
    // A missed permit is the correlation defense firing, so it leaves evidence like every other
    // refusal on this boundary rather than being the one silent one.
    onNone: () =>
      recordHostedPreflightRejection(input.caller, input.binding.operation).pipe(
        Effect.andThen(Effect.fail(new CanonicalCallRejected({ reason: "confirmation_rejected" })))
      ),
    onSome: (confirmationPermit) =>
      executeHostedCanonicalOperation({
        caller: input.caller,
        binding: input.binding,
        untrustedInput: input.untrustedInput,
        confirmationPermit,
        isExecutionActive: input.isExecutionActive,
      }),
  });

/**
 * Creates session-attributed handlers inside one structured hosted workflow. Prepared permits and
 * handlers are closure-owned, never serialized, and become unusable when the workflow closes.
 */
export const makeAgentToolkit = (input: {
  readonly caller: CanonicalCaller;
  readonly isExecutionActive: () => boolean;
}): Effect.Effect<AgentToolkitInstance, never, HostedExecutionRequirements> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const telemetry = yield* Telemetry;
    const crypto = yield* Crypto.Crypto;
    const inference = yield* HostedInference;
    const ledger = makePermitLedger();
    const invoke = (
      binding: AgentOperationBinding,
      untrustedInput: unknown
    ): Effect.Effect<unknown, object, HostedExecutionRequirements> =>
      Effect.suspend(() => spendPermit({ ...input, ledger, binding, untrustedInput }));
    const handlers = Object.fromEntries(
      agentOperationBindings.map((binding) => [
        binding.wireName,
        (untrustedInput: unknown): Effect.Effect<unknown, object> =>
          invoke(binding, untrustedInput).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(Telemetry, telemetry),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(HostedInference, inference),
            // A refusal the declared failure schema cannot carry back to the model ends the Turn.
            // It is already audited as `rejected` before reaching here, so dying with the rejection
            // itself keeps its reason in the Cause for the log rather than replacing it with prose.
            // Terminalization cannot read it: a defect carries no typed error, so the Turn records
            // the generic hosted reason.
            Effect.catch((failure) =>
              Schema.is(binding.failure)(failure) ? Effect.fail(failure) : Effect.die(failure)
            )
          ),
      ])
    );
    const handlerContext = yield* AgentToolkit.toHandlers(handlers);
    const toolkit = yield* AgentToolkit.pipe(Effect.provide(handlerContext));
    return {
      ...toolkit,
      prepare: (
        binding: AgentOperationBinding,
        canonicalInput: Schema.Json,
        permit: ConfirmationPermit
      ) =>
        Effect.suspend(() =>
          input.isExecutionActive()
            ? Effect.sync(() => ledger.offer(binding, canonicalInput, permit))
            : Effect.fail(new CanonicalCallRejected({ reason: "authority_closed" }))
        ),
      recordPreflightRejection: (binding: AgentOperationBinding) =>
        recordHostedPreflightRejection(input.caller, binding.operation).pipe(
          Effect.provideService(SqlClient.SqlClient, sql)
        ),
    };
  });
