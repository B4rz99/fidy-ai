import type { Crypto, Effect } from "effect";
import type { HttpApiEndpoint } from "effect/unstable/httpapi";
import type { SqlClient } from "effect/unstable/sql";
import type { HostedInference } from "~/shell/agent/hosted-inference";
import type { OperationId } from "~/shell/api";
import type { Telemetry } from "~/shell/observability/telemetry";
import type { CanonicalCaller, ChildOperationAudit } from "./authz";
import type { CanonicalEndpoint, CanonicalInput } from "./canonical-input";
import type { CanonicalSuccess } from "./canonical-success";

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

/** Every failure represented by an assembled canonical operation declaration. */
export type CanonicalFailure<Id extends OperationId> = HttpApiEndpoint.Errors<
  CanonicalEndpoint<Id>
>;

/** One implementation pinned to its operation's decoded input, success, and failure channels. */
export type CanonicalImplementation<Id extends OperationId> = (
  input: CanonicalInput<Id>,
  caller: CanonicalImplementationCaller
) => Effect.Effect<CanonicalSuccess<Id>, CanonicalFailure<Id>, CanonicalImplementationRequirements>;

/**
 * Every canonical implementation, each keyed by the operation it implements. Declarations take
 * their input, success, and failure types from the key rather than restating any one, so an
 * implementation cannot be filed under an incompatible operation or answer outside its declaration.
 */
export type CanonicalOperationImplementations = {
  readonly [Id in OperationId]: CanonicalImplementation<Id>;
};
