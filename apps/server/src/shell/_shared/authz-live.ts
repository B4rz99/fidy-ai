import {
  type Cause,
  Crypto,
  Data,
  DateTime,
  Duration,
  Effect,
  Encoding,
  Exit,
  Function,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { type AuditLogEntry, type AuditOutcome, CanonicalOperationId } from "~/core/audit/model";
import {
  allCanonicalCapabilities,
  canonicalCapabilitiesFromPatScopes,
} from "~/core/_shared/canonical-capability";
import { type ResolvedToken, TokenBearer } from "~/core/tokens/model";
import { computePatIdleExpiry } from "~/core/tokens/rules";
import { appendAuditLogEntry } from "~/shell/audit/repo";
import { onboardingConsentStandingInScope, withSubjectLock } from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { TokenHash, useToken } from "~/shell/tokens/repo";
import {
  renewedWebSessionCookieOptions,
  webSessionCookieOptions,
} from "~/shell/web-session/cookie";
import type { ResolvedWebSession } from "~/shell/web-session/repo";
import { authenticateWebSession } from "~/shell/web-session/service";
import {
  type CanonicalCallRejected,
  executeCanonicalEffect,
  findCanonicalCallRejected,
} from "./canonical-operation-executor";
import { ConsentRequired, ScopeMissing, Unauthenticated, UserActionRequired } from "./errors";
import {
  type CanonicalCaller,
  type ChildOperationAudit,
  type ResolvedCaller,
  TokenAuthorization,
  webSessionSecurity,
} from "./authz";
import { getOperationPolicy } from "./operation-policy";

const decodeBearer = Schema.decodeUnknownOption(TokenBearer);

const unauthenticated = (): Unauthenticated =>
  Unauthenticated.make({
    error: {
      code: "unauthenticated",
      message:
        "Every HTTP operation requires an active WebSession or known PAT. Present the host-only " +
        "browser cookie or send an opaque fin_ bearer in the Authorization header and retry.",
    },
    next: [],
  });

const freshWebSessionRequired = (): Unauthenticated =>
  Unauthenticated.make({
    error: {
      code: "unauthenticated",
      message:
        "This operation requires a freshly paired browser session. Pair this browser again and retry.",
    },
    next: [],
  });

const scopeMissing = (): ScopeMissing =>
  ScopeMissing.make({
    error: {
      code: "scope_missing",
      message:
        "This caller does not grant the authority declared by the attempted operation. " +
        "A PAT User can mint or broaden it in /settings/pats before retrying.",
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

type ResolvedCredential =
  | Readonly<{ _tag: "PAT"; resolved: ResolvedToken }>
  | Readonly<{
      _tag: "WebSession";
      resolved: ResolvedWebSession;
      bearer: string;
    }>;

class UserActionAuthenticationRejected extends Data.TaggedError(
  "UserActionAuthenticationRejected"
)<{
  readonly credential: ResolvedCredential;
  readonly access: "never-granted" | "revoked";
}> {}

class AccessAuthenticationRejected extends Data.TaggedError("AccessAuthenticationRejected")<{
  readonly credential: ResolvedCredential;
  readonly reason: CanonicalCallRejected["reason"];
}> {}

/** Finds an access refusal that must roll credential renewal back and map at the HTTP boundary. */
const credentialAccessRejection = (
  cause: Cause.Cause<unknown>
): Option.Option<CanonicalCallRejected> =>
  Option.filter(findCanonicalCallRejected(cause), ({ reason }) =>
    ["pat_scope_missing", "fresh_web_session_required", "caller_ineligible"].includes(reason)
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
 * the supplied use time while renewing its 90-day idle deadline.
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

const subjectUserIdOf = (
  credential: ResolvedCredential
): ResolvedCredential["resolved"]["subjectUserId"] => credential.resolved.subjectUserId;

const auditCallerOf = (credential: ResolvedCredential): CanonicalCaller["auditCaller"] =>
  credential._tag === "PAT"
    ? { _tag: "PAT", patId: credential.resolved.tokenId }
    : { _tag: "WebSession", webSessionId: credential.resolved.webSessionId };

const recordAuthorizationOutcome = ({
  credential,
  operation,
  outcome,
  occurredAt,
}: Readonly<{
  credential: ResolvedCredential;
  operation: CanonicalOperationId;
  outcome: AuditOutcome;
  occurredAt: DateTime.Utc;
}>): Effect.Effect<AuditLogEntry, never, SqlClient.SqlClient> =>
  appendAuditLogEntry(subjectUserIdOf(credential), {
    caller: auditCallerOf(credential),
    operation,
    outcome,
    occurredAt,
  });

const annotateOperationPolicy = (
  policy: ReturnType<typeof getOperationPolicy>
): Effect.Effect<void> =>
  Effect.annotateCurrentSpan({
    "fidy.operation.access": policy.access._tag,
  });

const recordRejectedAttempt = (
  attempt: Readonly<{
    credential: ResolvedCredential;
    operation: CanonicalOperationId;
    occurredAt: DateTime.Utc;
  }>
): Effect.Effect<AuditLogEntry, never, SqlClient.SqlClient> =>
  recordAuthorizationOutcome({ ...attempt, outcome: "rejected" });

const canonicalCallerFromCredential = (
  credential: ResolvedCredential,
  occurredAt: DateTime.Utc
): CanonicalCaller => {
  if (credential._tag === "PAT") {
    return {
      subjectUserId: credential.resolved.subjectUserId,
      capabilities: canonicalCapabilitiesFromPatScopes(credential.resolved.scopes),
      auditCaller: { _tag: "PAT", patId: credential.resolved.tokenId },
      authorityRoot: "no-verified-whatsapp-authority",
    };
  }
  return {
    subjectUserId: credential.resolved.subjectUserId,
    capabilities: allCanonicalCapabilities,
    auditCaller: { _tag: "WebSession", webSessionId: credential.resolved.webSessionId },
    authorityRoot: "no-verified-whatsapp-authority",
    fresh:
      DateTime.toEpochMillis(occurredAt) < DateTime.toEpochMillis(credential.resolved.freshUntil),
  };
};

const expireWebSessionCookie = HttpApiBuilder.securitySetCookie(webSessionSecurity, "", {
  ...webSessionCookieOptions,
  maxAge: Duration.zero,
});

const resolveWebSessionCredential = (
  redactedBearer: Redacted.Redacted<string>,
  usedAt: DateTime.Utc
): Effect.Effect<
  Option.Option<ResolvedCredential>,
  never,
  Crypto.Crypto | HttpServerRequest.HttpServerRequest | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const bearer = Redacted.value(redactedBearer);
    if (bearer === "") return Option.none<ResolvedCredential>();
    const resolved = yield* authenticateWebSession(bearer, usedAt);
    if (Option.isNone(resolved)) {
      yield* expireWebSessionCookie;
      return Option.none<ResolvedCredential>();
    }
    return Option.some({
      _tag: "WebSession",
      resolved: resolved.value,
      bearer,
    } as const satisfies ResolvedCredential);
  });

const resolvePatCredential = (
  redactedBearer: Redacted.Redacted<string>,
  usedAt: DateTime.Utc
): Effect.Effect<Option.Option<ResolvedCredential>, never, Crypto.Crypto | SqlClient.SqlClient> => {
  const bearer = decodeBearer(Redacted.value(redactedBearer));
  if (Option.isNone(bearer)) return Effect.succeed(Option.none<ResolvedCredential>());
  return Effect.map(authenticateTokenBearer(bearer.value, usedAt), (resolved) =>
    Option.map(
      resolved,
      (token) =>
        ({
          _tag: "PAT",
          resolved: token,
        }) as const satisfies ResolvedCredential
    )
  );
};

type AuthorizedEndpointInput<A, E, R> = Readonly<{
  httpEffect: Effect.Effect<A, E, R>;
  credential: ResolvedCredential;
  policy: ReturnType<typeof getOperationPolicy>;
  operation: CanonicalOperationId;
  occurredAt: DateTime.Utc;
}>;

const executeAuthorizedEndpoint = Effect.fn("executeAuthorizedEndpoint")(function* <A, E, R>({
  httpEffect,
  occurredAt,
  operation,
  policy,
  credential,
}: AuthorizedEndpointInput<A, E, R>) {
  yield* annotateOperationPolicy(policy);
  const exit = yield* Effect.exit(
    executeCanonicalEffect({
      caller: canonicalCallerFromCredential(credential, occurredAt),
      operation,
      policy,
      effect: httpEffect,
      executionCheckpoint: Effect.void,
      occurredAt,
    })
  );
  // An unauthorized call rolls credential renewal back. A failed authorized operation keeps it:
  // the credential performed work it was entitled to, matching the sealed #241 renewal decision.
  if (Exit.isFailure(exit)) {
    const rejection = credentialAccessRejection(exit.cause);
    if (Option.isSome(rejection)) {
      return yield* new AccessAuthenticationRejected({
        credential,
        reason: rejection.value.reason,
      });
    }
  }
  return { _tag: "OperationCompleted", exit, credential } as const;
});

type SecurityContext = Readonly<{
  endpoint: Parameters<typeof getOperationPolicy>[0] & Readonly<{ identifier: string }>;
  group: Readonly<{ identifier: string }>;
}>;

const renewWebSessionResponseCookie = (
  credential: ResolvedCredential,
  occurredAt: DateTime.Utc
): Effect.Effect<void, never, HttpServerRequest.HttpServerRequest> => {
  if (credential._tag === "PAT") return Effect.void;
  return HttpApiBuilder.securitySetCookie(
    webSessionSecurity,
    credential.bearer,
    renewedWebSessionCookieOptions(DateTime.distance(occurredAt, credential.resolved.idleExpiresAt))
  );
};

type CompletedOperation<A, E> = Readonly<{
  _tag: "OperationCompleted";
  exit: Exit.Exit<A, E | CanonicalCallRejected>;
  credential: ResolvedCredential;
}>;

type CredentialTransactionInput<A, E, R, RR> = Readonly<{
  httpEffect: Effect.Effect<A, E, R>;
  occurredAt: DateTime.Utc;
  operation: CanonicalOperationId;
  policy: ReturnType<typeof getOperationPolicy>;
  resolveCredential: (
    usedAt: DateTime.Utc
  ) => Effect.Effect<Option.Option<ResolvedCredential>, never, RR>;
}>;

const executeCredentialTransaction = <A, E, R, RR>({
  httpEffect,
  occurredAt,
  operation,
  policy,
  resolveCredential,
}: CredentialTransactionInput<A, E, R, RR>): Effect.Effect<
  CompletedOperation<A, E>,
  Unauthenticated | UserActionAuthenticationRejected | AccessAuthenticationRejected,
  RR | SqlClient.SqlClient | Exclude<Exclude<R, ResolvedCaller>, ChildOperationAudit>
> =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(occurredAt).pipe(
      Effect.flatMap(Effect.fromOption(unauthenticated))
    );
    const subjectUserId = subjectUserIdOf(credential);
    return yield* withUserTransaction(
      subjectUserId,
      withSubjectLock(
        subjectUserId,
        Effect.gen(function* () {
          const access = yield* onboardingConsentStandingInScope(subjectUserId);
          if (access !== "granted") {
            return yield* new UserActionAuthenticationRejected({ credential, access });
          }
          return yield* executeAuthorizedEndpoint({
            httpEffect,
            credential,
            policy,
            operation,
            occurredAt,
          });
        })
      )
    );
  });

type AuthorizationAttempt<RR> = Readonly<{
  resolveCredential: (
    usedAt: DateTime.Utc
  ) => Effect.Effect<Option.Option<ResolvedCredential>, never, RR>;
  recordRejection: boolean;
}>;

const authorizeCanonicalRequest = Effect.fn("CanonicalAuthorization.authorize")(function* <
  A,
  E,
  R,
  RR,
>(
  httpEffect: Effect.Effect<A, E, R>,
  { endpoint, group }: SecurityContext,
  { resolveCredential, recordRejection }: AuthorizationAttempt<RR>
) {
  const policy = getOperationPolicy(endpoint);
  const operation = CanonicalOperationId.make(`${group.identifier}.${endpoint.identifier}`);
  const occurredAt = yield* DateTime.now;
  const sql = yield* SqlClient.SqlClient;
  const result = yield* sql
    .withTransaction(
      executeCredentialTransaction({
        httpEffect,
        occurredAt,
        operation,
        policy,
        resolveCredential,
      })
    )
    .pipe(
      Effect.catchTags({
        UserActionAuthenticationRejected: ({ access, credential }) =>
          recordRejection
            ? recordRejectedAttempt({ credential, operation, occurredAt }).pipe(
                Effect.andThen(consentFailure(access))
              )
            : consentFailure(access),
        AccessAuthenticationRejected: ({ credential, reason }) => {
          const failure =
            reason === "fresh_web_session_required" ? freshWebSessionRequired() : scopeMissing();
          return recordRejection
            ? recordRejectedAttempt({ credential, operation, occurredAt }).pipe(
                Effect.andThen(Effect.fail(failure))
              )
            : Effect.fail(failure);
        },
        SqlError: Effect.die,
      })
    );

  yield* renewWebSessionResponseCookie(result.credential, occurredAt);
  return yield* result.exit.pipe(Effect.catchTag("CanonicalCallRejected", Effect.die));
});

const presentedPatBearer = Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? Redacted.make(authorization.slice("Bearer ".length))
    : Redacted.make("");
});

/**
 * Authorizes every canonical request from either an active WebSession cookie or PAT bearer. It
 * preserves the credential's stable UserId and capabilities, serializes current Consent with the
 * operation, records metadata-only audit evidence, and renews only credentials that pass caller
 * policy. Declared operation failures remain operation results rather than authentication errors.
 */
export const TokenAuthorizationLive = Layer.succeed(
  TokenAuthorization,
  TokenAuthorization.of({
    webSession: (httpEffect, { credential, ...context }) =>
      Effect.gen(function* () {
        const patBearer = yield* presentedPatBearer;
        if (Redacted.value(patBearer) !== "") {
          return yield* authorizeCanonicalRequest(httpEffect, context, {
            resolveCredential: (usedAt) => resolvePatCredential(patBearer, usedAt),
            recordRejection: false,
          });
        }
        return yield* authorizeCanonicalRequest(httpEffect, context, {
          resolveCredential: (usedAt) => resolveWebSessionCredential(credential, usedAt),
          recordRejection: true,
        });
      }),
    agentBearer: (httpEffect, { credential, ...context }) =>
      authorizeCanonicalRequest(httpEffect, context, {
        resolveCredential: (usedAt) => resolvePatCredential(credential, usedAt),
        recordRejection: true,
      }),
  })
);
