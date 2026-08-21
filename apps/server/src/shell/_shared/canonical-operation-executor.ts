import { Cause, Data, DateTime, Effect, Exit, Option, Ref, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { CanonicalOperationId } from "~/core/audit/model";
import { appendAuditLogEntry } from "~/shell/audit/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";
import {
  operationDescriptor,
  recordExpectedOutcome,
} from "~/shell/observability/canonical-operation-span";
import { TelemetryCodeSchema } from "~/shell/observability/registry";
import { Telemetry } from "~/shell/observability/telemetry";
import type { AgentOperationBinding } from "~/shell/agent/agent-operation-binding";
import type { ConfirmationPermit } from "~/shell/agent/tool-confirmation-model";
import {
  type CanonicalCaller,
  ChildOperationAudit,
  type ChildOperationAuditService,
  ResolvedCaller,
} from "./authz";
import { findCanonicalOperationImplementation } from "./canonical-operation-registry";
import { getBoundOperationCatalog } from "./operation-catalog";
import type { OperationPolicyValue } from "./operation-policy";

export class CanonicalCallRejected extends Data.TaggedError("CanonicalCallRejected")<{
  readonly reason:
    | "authority_closed"
    | "capability_missing"
    | "confirmation_rejected"
    | "input_rejected";
}> {}

/** Finds the rejection inside one Cause, so authorization and audit read a refusal the same way. */
export const findCanonicalCallRejected = (
  cause: Cause.Cause<unknown>
): Option.Option<CanonicalCallRejected> =>
  Option.flatMap(Cause.findErrorOption(cause), (failure) =>
    failure instanceof CanonicalCallRejected ? Option.some(failure) : Option.none()
  );

type ChildAuditEvidence = Readonly<{
  operation: CanonicalOperationId;
  outcome: "succeeded" | "rejected" | "failed";
  occurredAt: DateTime.Utc;
}>;

const appendOutcome = (input: {
  readonly caller: CanonicalCaller;
  readonly operation: CanonicalOperationId;
  readonly outcome: "succeeded" | "rejected" | "failed";
  readonly occurredAt: DateTime.Utc;
}): ReturnType<typeof appendAuditLogEntry> =>
  appendAuditLogEntry(input.caller.subjectUserId, {
    caller: input.caller.auditCaller,
    operation: input.operation,
    outcome: input.outcome,
    occurredAt: input.occurredAt,
  });

const provideCaller = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  caller: CanonicalCaller,
  childAudit: ChildOperationAuditService
): Effect.Effect<A, E, Exclude<Exclude<R, ResolvedCaller>, ChildOperationAudit>> =>
  effect.pipe(
    Effect.provideService(ResolvedCaller, caller),
    Effect.provideService(ChildOperationAudit, childAudit)
  );

/** A rolled-back transaction leaves no successful child, so its evidence records the rollback. */
const demoteSucceededChildren = (
  entries: ReadonlyArray<ChildAuditEvidence>
): ReadonlyArray<ChildAuditEvidence> =>
  entries.map((entry): ChildAuditEvidence =>
    entry.outcome === "succeeded" ? { ...entry, outcome: "failed" } : entry
  );

/** Separates a declared rejection from an unexpected failure in the rolled-back attempt's evidence. */
const recordRolledBackAttempt = (input: {
  readonly caller: CanonicalCaller;
  readonly operation: CanonicalOperationId;
  readonly occurredAt: DateTime.Utc;
  readonly cause: Cause.Cause<unknown>;
}): ReturnType<typeof appendOutcome> =>
  appendOutcome({
    caller: input.caller,
    operation: input.operation,
    occurredAt: input.occurredAt,
    outcome: Option.isSome(findCanonicalCallRejected(input.cause)) ? "rejected" : "failed",
  });

/**
 * Shared transaction and audit checkpoint used after either PAT or hosted authorization resolves
 * one credential-neutral caller. Successful state and evidence commit together; failure evidence
 * is appended only after rollback.
 */
export const executeCanonicalEffect = Effect.fn("executeCanonicalEffect")(function* <
  A,
  E,
  R,
>(input: {
  readonly caller: CanonicalCaller;
  readonly operation: CanonicalOperationId;
  readonly policy: OperationPolicyValue;
  readonly effect: Effect.Effect<A, E, R>;
  readonly executionCheckpoint: Effect.Effect<void, CanonicalCallRejected, R>;
  readonly occurredAt: DateTime.Utc;
}) {
  const { caller, effect, executionCheckpoint, occurredAt, operation, policy } = input;
  if (
    policy.scopeEvaluation !== "children" &&
    !caller.capabilities.includes(policy.requiredScope)
  ) {
    yield* appendOutcome({ caller, operation, outcome: "rejected", occurredAt });
    return yield* new CanonicalCallRejected({ reason: "capability_missing" });
  }

  const childEvidence = yield* Ref.make<ReadonlyArray<ChildAuditEvidence>>([]);
  const childAudit = ChildOperationAudit.of({
    record: (evidence) => Ref.update(childEvidence, (entries) => [...entries, evidence]),
  });
  const execution = provideCaller(
    executionCheckpoint.pipe(Effect.andThen(effect)),
    caller,
    childAudit
  );
  const exit = yield* Effect.exit(
    withUserTransaction(
      caller.subjectUserId,
      execution.pipe(
        Effect.tap(() => appendOutcome({ caller, operation, outcome: "succeeded", occurredAt }))
      )
    )
  );

  if (Exit.isFailure(exit)) {
    yield* recordRolledBackAttempt({ caller, operation, occurredAt, cause: exit.cause });
    yield* Ref.update(childEvidence, demoteSucceededChildren);
  }
  for (const evidence of yield* Ref.get(childEvidence)) {
    yield* appendOutcome({ caller, ...evidence });
  }
  return yield* exit;
});

/** Records the declared rejection before failing, so hosted evidence exists for every refusal. */
const rejectHostedCall = Effect.fn("rejectHostedCall")(function* (input: {
  readonly caller: CanonicalCaller;
  readonly operation: CanonicalOperationId;
  readonly occurredAt: DateTime.Utc;
  readonly reason: CanonicalCallRejected["reason"];
}) {
  yield* appendOutcome({
    caller: input.caller,
    operation: input.operation,
    outcome: "rejected",
    occurredAt: input.occurredAt,
  });
  return yield* new CanonicalCallRejected({ reason: input.reason });
});

/** Resolves the declared operation, its implementation, and the exact input a permit must confirm. */
const resolveHostedCall = Effect.fn("resolveHostedCall")(function* (input: {
  readonly caller: CanonicalCaller;
  readonly binding: AgentOperationBinding;
  readonly untrustedInput: unknown;
  readonly occurredAt: DateTime.Utc;
}) {
  const { binding, caller, occurredAt, untrustedInput } = input;
  const declaration = getBoundOperationCatalog().byId.get(binding.operation);
  const implementation = findCanonicalOperationImplementation(binding.operation);
  if (declaration === undefined || Option.isNone(implementation)) {
    return yield* Effect.die(new Error("Canonical operation declaration is incomplete"));
  }
  const canonicalInput = yield* Schema.decodeUnknownEffect(declaration.input)(untrustedInput).pipe(
    Effect.catch(() =>
      rejectHostedCall({
        caller,
        operation: binding.operation,
        occurredAt,
        reason: "input_rejected",
      })
    )
  );
  // The confirmed identity is the schema's own encoding, so a permit compares normalized JSON
  // rather than the decoded domain values.
  const canonicalJson = yield* Schema.encodeEffect(declaration.input)(canonicalInput).pipe(
    Effect.orDie
  );
  return {
    policy: declaration.policy,
    execute: implementation.value,
    canonicalInput,
    canonicalJson,
  } as const;
});

/** Spends the single-use permit and rechecks the workflow inside the canonical transaction. */
const hostedExecutionCheckpoint = (input: {
  readonly confirmationPermit: ConfirmationPermit;
  readonly binding: AgentOperationBinding;
  readonly canonicalJson: Schema.Json;
  readonly isExecutionActive: () => boolean;
}): Effect.Effect<void, CanonicalCallRejected, SqlClient.SqlClient> =>
  input.confirmationPermit
    .consume({ binding: input.binding, canonicalInput: input.canonicalJson })
    .pipe(
      Effect.flatMap((confirmed) => {
        if (!confirmed) {
          return Effect.fail(new CanonicalCallRejected({ reason: "confirmation_rejected" }));
        }
        return input.isExecutionActive()
          ? Effect.void
          : Effect.fail(new CanonicalCallRejected({ reason: "authority_closed" }));
      })
    );

/**
 * Deep hosted entry: owns catalog lookup, canonical decoding, policy and implementation selection,
 * exact permit consumption, Consent, RLS transaction, and audit evidence.
 */
export const executeHostedCanonicalOperation = Effect.fn("executeHostedCanonicalOperation")(
  function* (input: {
    readonly caller: CanonicalCaller;
    readonly binding: AgentOperationBinding;
    readonly untrustedInput: unknown;
    readonly confirmationPermit: ConfirmationPermit;
    readonly isExecutionActive: () => boolean;
  }) {
    const { binding, caller, confirmationPermit, isExecutionActive, untrustedInput } = input;
    const occurredAt = yield* DateTime.now;
    if (!isExecutionActive()) {
      return yield* rejectHostedCall({
        caller,
        operation: binding.operation,
        occurredAt,
        reason: "authority_closed",
      });
    }
    const call = yield* resolveHostedCall({ caller, binding, untrustedInput, occurredAt });
    // In-process hosted execution reuses the canonical operation span the HTTP middleware emits, so
    // a hosted call stays as observable as the same operation invoked by the User's own agent.
    const telemetry = yield* Telemetry;
    const spanOperation = yield* Schema.decodeUnknownEffect(TelemetryCodeSchema.operation)(
      binding.operation
    ).pipe(Effect.orDie);
    return yield* telemetry.span(
      operationDescriptor(spanOperation),
      executeCanonicalEffect({
        caller,
        operation: binding.operation,
        policy: call.policy,
        effect: call.execute(call.canonicalInput, { resolved: caller }),
        executionCheckpoint: hostedExecutionCheckpoint({
          confirmationPermit,
          binding,
          canonicalJson: call.canonicalJson,
          isExecutionActive,
        }),
        occurredAt,
      }).pipe(Effect.tapError(recordExpectedOutcome(telemetry)))
    );
  }
);

/** Records a recognized hosted call rejected by complete-response preflight. */
export const recordHostedPreflightRejection = Effect.fn("recordHostedPreflightRejection")(
  function* (caller: CanonicalCaller, operation: CanonicalOperationId) {
    yield* appendOutcome({
      caller,
      operation,
      outcome: "rejected",
      occurredAt: yield* DateTime.now,
    });
  }
);
