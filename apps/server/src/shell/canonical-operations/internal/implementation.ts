import type {
  CanonicalEndpoint,
  CanonicalImplementationCaller,
  CanonicalInput,
  CanonicalSuccess,
} from "~/shell/canonical-operations/contract";
import type { Crypto, Effect } from "effect";
import type { HttpApiEndpoint } from "effect/http-api";
import type { SqlClient } from "effect/sql";
import type { HostedInference } from "~/shell/hosted-inference/operations";
import type { EmailReplacementMutation } from "~/shell/email-authentication/operations";
import type { OperationId } from "~/shell/api";
import type { Telemetry } from "~/shell/observability/operations";
import type { ChildOperationAudit } from "~/shell/authorization/contract";

export type { CanonicalImplementationCaller } from "~/shell/canonical-operations/contract";

/** What canonical execution itself requires, before any child-operation auditing. */
export type CanonicalExecutionRequirements =
  | SqlClient.SqlClient
  | Telemetry
  | Crypto.Crypto
  | HostedInference
  | EmailReplacementMutation;

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
