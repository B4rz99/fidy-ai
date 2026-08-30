import { Cause, Data, DateTime, Effect, Exit, Option, Ref, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { CanonicalOperationId } from "~/core/audit/model";
import type { ProviderQualifiedMessages } from "~/core/consent/model";
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
  toAccessCaller,
} from "./authz";
import { findCanonicalOperationImplementation } from "./canonical-operation-registry";
import {
  CanonicalPreTransactionStates,
  CanonicalPreTransactions,
} from "./canonical-pre-transaction";
import { canonicalTransactionIsolation, retryCanonicalSnapshot } from "./canonical-snapshot";
import { isCanonicalRejectedFailure } from "./errors";
import { getBoundOperationCatalog } from "./operation-catalog";
import { type OperationPolicyValue, decideOperationAccess } from "./operation-policy";

export class CanonicalCallRejected extends Data.TaggedError("CanonicalCallRejected")<{
  readonly reason:
    | "authority_closed"
    | "pat_scope_missing"
    | "fresh_web_session_required"
    | "caller_ineligible"
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
const isDeclaredRejection = (cause: Cause.Cause<unknown>): boolean =>
  Option.exists(Cause.findErrorOption(cause), isCanonicalRejectedFailure);

const isRolledBackRejection = (cause: Cause.Cause<unknown>): boolean =>
  Option.isSome(findCanonicalCallRejected(cause)) || isDeclaredRejection(cause);

const recordRejectedOrFailedAttempt = (input: {
  readonly caller: CanonicalCaller;
  readonly operation: CanonicalOperationId;
  readonly occurredAt: DateTime.Utc;
  readonly cause: Cause.Cause<unknown>;
}): Effect.Effect<void, never, SqlClient.SqlClient> =>
  appendOutcome({
    caller: input.caller,
    operation: input.operation,
    occurredAt: input.occurredAt,
    outcome: isRolledBackRejection(input.cause) ? "rejected" : "failed",
  });

const runPreTransactionCheckpoint = (input: {
  readonly caller: CanonicalCaller;
  readonly operation: CanonicalOperationId;
  readonly occurredAt: DateTime.Utc;
  readonly effect: object;
}): Effect.Effect<ReadonlyArray<Schema.Json>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const checkpoint = CanonicalPreTransactions.find(input.effect, input.caller, input.operation);
    if (Option.isNone(checkpoint)) return [];
    const exit = yield* Effect.exit(checkpoint.value);
    if (Exit.isSuccess(exit)) return exit.value;
    yield* recordRejectedOrFailedAttempt({ ...input, cause: exit.cause });
    return yield* exit;
  }).pipe(Effect.withSpan("runCanonicalPreTransactionCheckpoint"));

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
  const access = decideOperationAccess(policy.access, toAccessCaller(caller));
  if (access._tag === "Denied") {
    yield* appendOutcome({ caller, operation, outcome: "rejected", occurredAt });
    return yield* new CanonicalCallRejected({ reason: access.reason });
  }

  const preparedStates = yield* runPreTransactionCheckpoint({
    caller,
    operation,
    occurredAt,
    effect,
  });
  const preTransactionStates = yield* Ref.make(preparedStates);
  const childEvidence = yield* Ref.make<ReadonlyArray<ChildAuditEvidence>>([]);
  const childAudit = ChildOperationAudit.of({
    record: (evidence) => Ref.update(childEvidence, (entries) => [...entries, evidence]),
  });
  const execution = provideCaller(
    executionCheckpoint.pipe(
      Effect.andThen(effect),
      Effect.provideService(CanonicalPreTransactionStates, Option.some(preTransactionStates))
    ),
    caller,
    childAudit
  );
  const operationTransaction = withUserTransaction(
    caller.subjectUserId,
    execution.pipe(
      Effect.tap(() => appendOutcome({ caller, operation, outcome: "succeeded", occurredAt }))
    ),
    canonicalTransactionIsolation(operation)
  );
  const exit = yield* Effect.exit(
    retryCanonicalSnapshot({ operation, effect: operationTransaction })
  );

  if (Exit.isFailure(exit)) {
    yield* recordRejectedOrFailedAttempt({ caller, operation, occurredAt, cause: exit.cause });
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
  readonly retainEvidence: (evidence: Option.Option<ProviderQualifiedMessages>) => void;
}): Effect.Effect<void, CanonicalCallRejected, SqlClient.SqlClient> =>
  input.confirmationPermit
    .consume({ binding: input.binding, canonicalInput: input.canonicalJson })
    .pipe(
      Effect.flatMap((consumption) => {
        if (!consumption.confirmed) {
          return Effect.fail(new CanonicalCallRejected({ reason: "confirmation_rejected" }));
        }
        input.retainEvidence(consumption.evidence);
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
    let confirmationEvidence = Option.none<ProviderQualifiedMessages>();
    // In-process hosted execution reuses the canonical operation span the HTTP middleware emits, so
    // a hosted call stays as observable as the same operation invoked by the User's own agent.
    const telemetry = yield* Telemetry;
    const spanOperation = yield* Schema.decodeEffect(TelemetryCodeSchema.operation)(
      binding.operation
    ).pipe(Effect.orDie);
    return yield* telemetry.span(
      operationDescriptor(spanOperation),
      executeCanonicalEffect({
        caller,
        operation: binding.operation,
        policy: call.policy,
        effect: call.execute(call.canonicalInput, {
          resolved: caller,
          confirmationEvidence: () => confirmationEvidence,
        }),
        executionCheckpoint: hostedExecutionCheckpoint({
          confirmationPermit,
          binding,
          canonicalJson: call.canonicalJson,
          isExecutionActive,
          retainEvidence: (evidence) => {
            confirmationEvidence = evidence;
          },
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
