import {
  type Cause,
  Crypto,
  Data,
  DateTime,
  Effect,
  Encoding,
  Exit,
  Function,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { type AuditLogEntry, type AuditOutcome, CanonicalOperationId } from "~/core/audit/model";
import { canonicalCapabilitiesFromPatScopes } from "~/core/_shared/canonical-capability";
import { type ResolvedToken, TokenBearer } from "~/core/tokens/model";
import { computePatIdleExpiry } from "~/core/tokens/rules";
import { appendAuditLogEntry } from "~/shell/audit/repo";
import { onboardingConsentStandingInScope, withSubjectLock } from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { TokenHash, useToken } from "~/shell/tokens/repo";
import { executeCanonicalEffect, findCanonicalCallRejected } from "./canonical-operation-executor";
import { ConsentRequired, ScopeMissing, Unauthenticated, UserActionRequired } from "./errors";
import { type CanonicalCaller, TokenAuthorization } from "./authz";
import { getOperationPolicy } from "./operation-policy";

const decodeBearer = Schema.decodeUnknownEffect(TokenBearer);

const unauthenticated = (): Unauthenticated =>
  Unauthenticated.make({
    error: {
      code: "unauthenticated",
      message:
        "Every HTTP operation requires a known PAT. Send its opaque fin_ bearer in the " +
        "Authorization header and retry.",
    },
    next: [],
  });

const scopeMissing = (): ScopeMissing =>
  ScopeMissing.make({
    error: {
      code: "scope_missing",
      message:
        "This bearer does not grant the scope declared by the attempted operation. " +
        "Ask the User to mint or broaden a PAT in /settings/pats before retrying.",
    },
    next: [],
  });

const consentRequired = (): ConsentRequired =>
  ConsentRequired.make({
    error: {
      code: "consent_required",
      message:
        "This User has not accepted Fidy's onboarding Consent. Ask them to accept it on a " +
        "Fidy-owned surface; this agent cannot accept Consent on their behalf.",
    },
    next: [],
  });

const userActionRequired = (): UserActionRequired =>
  UserActionRequired.make({
    error: {
      code: "user_action_required",
      message:
        "The User explicitly revoked Consent. Ask them to return to a Fidy-owned surface; " +
        "this agent cannot accept Consent or retry canonical work on their behalf.",
    },
    next: [],
  });

/** Reports the action the User must take, keeping absent onboarding distinct from revocation. */
const consentFailure = (
  access: "never-granted" | "revoked"
): Effect.Effect<never, ConsentRequired | UserActionRequired> =>
  access === "revoked" ? Effect.fail(userActionRequired()) : Effect.fail(consentRequired());

class UserActionAuthenticationRejected extends Data.TaggedError(
  "UserActionAuthenticationRejected"
)<{ readonly resolved: ResolvedToken; readonly access: "never-granted" | "revoked" }> {}

class ScopeAuthenticationRejected extends Data.TaggedError("ScopeAuthenticationRejected")<{
  readonly resolved: ResolvedToken;
}> {}

/** A transferable bearer can neither exceed its scope nor invoke hosted-only authority. */
const isBearerIneligible = (cause: Cause.Cause<unknown>): boolean =>
  Option.exists(findCanonicalCallRejected(cause), (rejection) =>
    ["capability_missing", "caller_ineligible"].includes(rejection.reason)
  );

/**
 * SHA-256 hashes one opaque bearer with the platform Crypto service. Token
 * lookup accepts this lowercase digest and never the full bearer or its secret.
 */
export const hashTokenBearer = (
  bearer: TokenBearer
): Effect.Effect<TokenHash, never, Crypto.Crypto> =>
  Effect.flatMap(Crypto.Crypto, (crypto) =>
    crypto.digest("SHA-256", new TextEncoder().encode(bearer))
  ).pipe(
    Effect.map((digest) => TokenHash.make(Encoding.encodeHex(digest))),
    Effect.orDie
  );

/**
 * Resolves a typed TokenBearer bearer to its stable User and atomically records
 * the supplied use time while renewing its 90-day idle deadline. The caller
 * supplies one UTC instant for both writes. Unknown, revoked, and idle-expired
 * grants remain `None`; database failures are defects.
 */
export const authenticateTokenBearer: {
  (
    usedAt: DateTime.Utc
  ): (
    self: TokenBearer
  ) => Effect.Effect<Option.Option<ResolvedToken>, never, Crypto.Crypto | SqlClient.SqlClient>;
  (
    self: TokenBearer,
    usedAt: DateTime.Utc
  ): Effect.Effect<Option.Option<ResolvedToken>, never, Crypto.Crypto | SqlClient.SqlClient>;
} = Function.dual(2, (self: TokenBearer, usedAt: DateTime.Utc) =>
  Effect.gen(function* () {
    const tokenHash = yield* hashTokenBearer(self);
    const renewedIdleExpiresAt = yield* computePatIdleExpiry(usedAt);
    return yield* useToken({ tokenHash, usedAt, renewedIdleExpiresAt });
  })
);

const recordAuthorizationOutcome = ({
  resolved,
  operation,
  outcome,
  occurredAt,
}: Readonly<{
  resolved: ResolvedToken;
  operation: CanonicalOperationId;
  outcome: AuditOutcome;
  occurredAt: DateTime.Utc;
}>): Effect.Effect<AuditLogEntry, never, SqlClient.SqlClient> =>
  appendAuditLogEntry(resolved.subjectUserId, {
    caller: { _tag: "PAT", patId: resolved.tokenId },
    operation,
    outcome,
    occurredAt,
  });

const annotateOperationPolicy = (
  policy: ReturnType<typeof getOperationPolicy>
): Effect.Effect<void> =>
  Effect.annotateCurrentSpan({
    "fidy.operation.required_capability": policy.requiredCapability,
  });

const recordRejectedAttempt = (
  attempt: Readonly<{
    resolved: ResolvedToken;
    operation: CanonicalOperationId;
    occurredAt: DateTime.Utc;
  }>
): Effect.Effect<AuditLogEntry, never, SqlClient.SqlClient> =>
  recordAuthorizationOutcome({ ...attempt, outcome: "rejected" });

const canonicalCallerFromPat = (resolved: ResolvedToken): CanonicalCaller => ({
  subjectUserId: resolved.subjectUserId,
  capabilities: canonicalCapabilitiesFromPatScopes(resolved.scopes),
  auditCaller: { _tag: "PAT", patId: resolved.tokenId },
  authorityRoot: "no-verified-whatsapp-authority",
});

type AuthorizedEndpointInput<A, E, R> = Readonly<{
  httpEffect: Effect.Effect<A, E, R>;
  resolved: ResolvedToken;
  policy: ReturnType<typeof getOperationPolicy>;
  operation: CanonicalOperationId;
  occurredAt: DateTime.Utc;
}>;

const executeAuthorizedEndpoint = Effect.fn("executeAuthorizedEndpoint")(function* <A, E, R>({
  httpEffect,
  occurredAt,
  operation,
  policy,
  resolved,
}: AuthorizedEndpointInput<A, E, R>) {
  yield* annotateOperationPolicy(policy);
  const exit = yield* Effect.exit(
    executeCanonicalEffect({
      caller: canonicalCallerFromPat(resolved),
      operation,
      policy,
      effect: httpEffect,
      executionCheckpoint: Effect.void,
      occurredAt,
    })
  );
  // An unauthorized call is not successful use, so its rejection escapes the bearer transaction and
  // takes the idle renewal down with it. A failed *authorized* operation keeps the renewal: the
  // bearer did work it was entitled to. Evidence is re-appended after the rollback.
  if (Exit.isFailure(exit) && isBearerIneligible(exit.cause)) {
    return yield* new ScopeAuthenticationRejected({ resolved });
  }
  return { _tag: "OperationCompleted", exit } as const;
});

/**
 * Live operation-derived bearer authorization for the HTTP server. Each call
 * authenticates its bearer, rejects access after explicit Consent revocation, rejects a
 * missing declared scope, and appends metadata-only AuditLogEntry evidence.
 * Explicit revocation rolls back token renewal and returns `UserActionRequired` after
 * recording rejection evidence. A successful operation and its evidence commit
 * in one SQL transaction; rejected and failed attempts append their evidence
 * separately. Authentication, consent, and scope failures remain typed HTTP
 * failures, while persistence failures are defects.
 */
export const TokenAuthorizationLive = Layer.succeed(
  TokenAuthorization,
  TokenAuthorization.of({
    agentBearer: Effect.fn(function* (httpEffect, { credential: redactedBearer, endpoint, group }) {
      const policy = getOperationPolicy(endpoint);
      const operation = CanonicalOperationId.make(`${group.identifier}.${endpoint.identifier}`);
      const bearer = yield* decodeBearer(Redacted.value(redactedBearer)).pipe(
        Effect.mapError(unauthenticated)
      );
      const occurredAt = yield* DateTime.now;
      const sql = yield* SqlClient.SqlClient;
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const resolved = yield* authenticateTokenBearer(bearer, occurredAt).pipe(
              Effect.flatMap(Effect.fromOption(unauthenticated))
            );
            return yield* withUserTransaction(
              resolved.subjectUserId,
              // The subject lock spans the check and the work it authorizes, so a revocation
              // committing in between cannot let an authorized write land (ADR 0008).
              withSubjectLock(
                resolved.subjectUserId,
                Effect.gen(function* () {
                  const access = yield* onboardingConsentStandingInScope(resolved.subjectUserId);
                  if (access !== "granted") {
                    return yield* new UserActionAuthenticationRejected({ resolved, access });
                  }
                  return yield* executeAuthorizedEndpoint({
                    httpEffect,
                    resolved,
                    policy,
                    operation,
                    occurredAt,
                  });
                })
              )
            );
          })
        )
        .pipe(
          Effect.catchTags({
            UserActionAuthenticationRejected: ({ access, resolved }) =>
              recordRejectedAttempt({ resolved, operation, occurredAt }).pipe(
                Effect.andThen(consentFailure(access))
              ),
            ScopeAuthenticationRejected: ({ resolved }) =>
              recordRejectedAttempt({ resolved, operation, occurredAt }).pipe(
                Effect.andThen(Effect.fail(scopeMissing()))
              ),
            SqlError: Effect.die,
          })
        );

      // Scope rejection already left as a typed failure above; any other reason is hosted-only.
      return yield* result.exit.pipe(Effect.catchTag("CanonicalCallRejected", Effect.die));
    }),
  })
);
