import type { Crypto, Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { HostedInference } from "~/shell/agent/hosted-inference";
import type { Telemetry } from "~/shell/observability/telemetry";
import type { CanonicalCaller, ChildOperationAudit } from "./authz";
import type { CanonicalInput } from "./canonical-input";
import type { OperationId } from "~/shell/api";

/** Caller facts supplied to every canonical implementation once the executor has resolved one. */
export type CanonicalImplementationCaller = Readonly<{ resolved: CanonicalCaller }>;

/** What canonical execution itself requires, before any child-operation auditing. */
export type CanonicalExecutionRequirements =
  | SqlClient.SqlClient
  | Telemetry
  | Crypto.Crypto
  | HostedInference;

/** Everything a canonical implementation may still require once the executor has resolved a caller. */
export type CanonicalImplementationRequirements =
  | CanonicalExecutionRequirements
  | ChildOperationAudit;

/**
 * Every canonical implementation, each keyed by the operation it implements and taking exactly that
 * operation's decoded input. Declarations take their input type from the key rather than restating
 * it, so an implementation cannot be filed under one operation while accepting another's input.
 */
export type CanonicalOperationImplementations = {
  readonly [Id in OperationId]: (
    input: CanonicalInput<Id>,
    caller: CanonicalImplementationCaller
  ) => Effect.Effect<unknown, object, CanonicalImplementationRequirements>;
};
