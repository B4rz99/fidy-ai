import {
  Context,
  Crypto,
  Data,
  DateTime,
  Effect,
  Encoding,
  Exit,
  Layer,
  type Option,
  Redacted,
  Schema,
} from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "effect/unstable/httpapi";
import { type AuditLogEntry, type AuditOutcome, CanonicalOperationId } from "~/core/audit/model";
import {
  AgentBearerToken,
  AgentBearerTokenFormat,
  type ResolvedAgentToken,
} from "~/core/tokens/model";
import { renewAgentTokenIdleExpiry } from "~/core/tokens/rules";
import { appendAuditLogEntry } from "~/shell/audit/repo";
import { useCurrentConsent } from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { AgentTokenHash, useAgentToken } from "~/shell/tokens/repo";
import { ConsentRequired, ScopeMissing, Unauthenticated } from "./errors";
import { getOperationPolicy } from "./operation-policy";

const decodeAgentBearer = Schema.decodeUnknownEffect(AgentBearerToken);

const unauthenticated = (): Unauthenticated =>
  Unauthenticated.make({
    error: {
      code: "unauthenticated",
      message:
        "Every operation requires a known AgentToken. Send its opaque fin_ bearer in the " +
        "Authorization header and retry.",
    },
    next: [],
  });

const scopeMissing = (): ScopeMissing =>
  ScopeMissing.make({
    error: {
      code: "scope_missing",
      message:
        "This AgentToken does not grant the scope declared by the attempted operation. " +
        "Ask the user in chat to mint or broaden a token before retrying.",
    },
    next: [],
  });

const consentRequired = (): ConsentRequired =>
  ConsentRequired.make({
    error: {
      code: "consent_required",
      message:
        "The User has no current onboarding consent. Return to the chat disclosure flow; " +
        "do not retry or execute any canonical operation until explicit acceptance.",
    },
    next: [],
  });

class ConsentAuthenticationRejected extends Data.TaggedError("ConsentAuthenticationRejected")<{
  readonly resolved: ResolvedAgentToken;
}> {}

class ScopeAuthenticationRejected extends Data.TaggedError("ScopeAuthenticationRejected")<{
  readonly resolved: ResolvedAgentToken;
}> {}

/**
 * SHA-256 hashes one opaque bearer with the platform Crypto service. Token
 * lookup accepts this lowercase digest and never the full bearer or its secret.
 */
export const hashAgentBearer = (
  bearer: AgentBearerToken
): Effect.Effect<AgentTokenHash, never, Crypto.Crypto> =>
  Effect.flatMap(Crypto.Crypto, (crypto) =>
    crypto.digest("SHA-256", new TextEncoder().encode(bearer))
  ).pipe(
    Effect.map((digest) => AgentTokenHash.make(Encoding.encodeHex(digest))),
    Effect.orDie
  );

/**
 * Resolves a typed AgentToken bearer to its stable User and atomically records
 * the supplied use time while renewing its 90-day idle deadline. The caller
 * supplies one UTC instant for both writes. Unknown, revoked, and idle-expired
 * grants remain `None`; database failures are defects.
 */
export const authenticateAgentToken = ({
  bearer,
  usedAt,
}: {
  readonly bearer: AgentBearerToken;
  readonly usedAt: DateTime.Utc;
}): Effect.Effect<Option.Option<ResolvedAgentToken>, never, Crypto.Crypto | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const tokenHash = yield* hashAgentBearer(bearer);
    const renewedIdleExpiresAt = yield* renewAgentTokenIdleExpiry(usedAt);
    return yield* useAgentToken({ tokenHash, usedAt, renewedIdleExpiresAt });
  });

/**
 * The request-scoped result of bearer authorization. Handlers read it once and
 * continue passing its stable UserId explicitly; core and repositories never
 * depend on request context.
 */
export class ResolvedCaller extends Context.Service<ResolvedCaller, ResolvedAgentToken>()(
  "fidy-ai/shell/_shared/authz/ResolvedCaller"
) {}

/**
 * Security middleware attached once to the assembled API. It reads bearer
 * scope and cost exclusively from active endpoint metadata, resolves and renews
 * the AgentToken once, and provides that result only to the current request.
 * No route identifier or path participates in authorization.
 */
export class AgentAuthorization extends HttpApiMiddleware.Service<
  AgentAuthorization,
  {
    provides: ResolvedCaller;
    requires: Crypto.Crypto | SqlClient.SqlClient;
  }
>()("fidy-ai/shell/_shared/authz/AgentAuthorization", {
  requiredForClient: true,
  security: {
    agentBearer: HttpApiSecurity.bearer.pipe(
      HttpApiSecurity.annotate(OpenApi.Format, AgentBearerTokenFormat)
    ),
  },
  error: [Unauthenticated, ConsentRequired, ScopeMissing],
}) {}

const recordAuthorizationOutcome = ({
  resolved,
  operation,
  outcome,
  occurredAt,
}: Readonly<{
  resolved: ResolvedAgentToken;
  operation: CanonicalOperationId;
  outcome: AuditOutcome;
  occurredAt: DateTime.Utc;
}>): Effect.Effect<AuditLogEntry, never, SqlClient.SqlClient> =>
  appendAuditLogEntry(resolved.subjectUserId, {
    tokenId: resolved.tokenId,
    operation,
    outcome,
    occurredAt,
  });

const annotateOperationPolicy = (
  policy: ReturnType<typeof getOperationPolicy>
): Effect.Effect<void> =>
  Effect.annotateCurrentSpan({
    "fidy.operation.required_scope": policy.requiredScope,
    "fidy.operation.cost_class": policy.costClass,
  });

const recordRejectedAttempt = (
  attempt: Readonly<{
    resolved: ResolvedAgentToken;
    operation: CanonicalOperationId;
    occurredAt: DateTime.Utc;
  }>
): Effect.Effect<AuditLogEntry, never, SqlClient.SqlClient> =>
  recordAuthorizationOutcome({ ...attempt, outcome: "rejected" });

const operationAudit =
  (attempt: {
    readonly resolved: ResolvedAgentToken;
    readonly operation: CanonicalOperationId;
    readonly occurredAt: DateTime.Utc;
  }): ((outcome: AuditOutcome) => Effect.Effect<AuditLogEntry, never, SqlClient.SqlClient>) =>
  (outcome) =>
    recordAuthorizationOutcome({ ...attempt, outcome });

const provideResolvedCaller = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  resolved: ResolvedAgentToken
): Effect.Effect<A, E, Exclude<R, ResolvedCaller>> =>
  Effect.provideService(effect, ResolvedCaller, resolved);

/**
 * Live operation-derived bearer authorization for the HTTP server. Each call
 * authenticates its AgentToken, requires current onboarding consent, rejects a
 * missing declared scope, and appends metadata-only AuditLogEntry evidence.
 * Missing consent rolls back token renewal and returns `ConsentRequired` after
 * recording rejection evidence. A successful operation and its evidence commit
 * in one SQL transaction; rejected and failed attempts append their evidence
 * separately. Authentication, consent, and scope failures remain typed HTTP
 * failures, while persistence failures are defects.
 */
export const AgentAuthorizationLive = Layer.succeed(
  AgentAuthorization,
  AgentAuthorization.of({
    agentBearer: Effect.fn(function* (httpEffect, { credential: redactedBearer, endpoint, group }) {
      const policy = getOperationPolicy(endpoint);
      const operation = CanonicalOperationId.make(`${group.identifier}.${endpoint.identifier}`);
      const bearer = yield* decodeAgentBearer(Redacted.value(redactedBearer)).pipe(
        Effect.mapError(unauthenticated)
      );
      const occurredAt = yield* DateTime.now;
      const sql = yield* SqlClient.SqlClient;
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const resolved = yield* authenticateAgentToken({
              bearer,
              usedAt: occurredAt,
            }).pipe(Effect.flatMap(Effect.fromOption(unauthenticated)));
            return yield* withUserTransaction(
              resolved.subjectUserId,
              useCurrentConsent(
                resolved.subjectUserId,
                () => Effect.fail(new ConsentAuthenticationRejected({ resolved })),
                Effect.gen(function* () {
                  const audit = operationAudit({ resolved, operation, occurredAt });

                  if (!resolved.scopes.includes(policy.requiredScope)) {
                    return yield* new ScopeAuthenticationRejected({ resolved });
                  }

                  yield* annotateOperationPolicy(policy);

                  const authorizedEffect = provideResolvedCaller(httpEffect, resolved);
                  const exit = yield* Effect.exit(
                    sql.withTransaction(
                      authorizedEffect.pipe(Effect.tap(audit.bind(null, "succeeded")))
                    )
                  );
                  if (Exit.isFailure(exit)) {
                    yield* audit("failed");
                  }
                  return { _tag: "OperationCompleted", exit } as const;
                })
              )
            );
          })
        )
        .pipe(
          Effect.catchTags({
            ConsentAuthenticationRejected: ({ resolved }) =>
              recordRejectedAttempt({ resolved, operation, occurredAt }).pipe(
                Effect.andThen(consentRequired())
              ),
            ScopeAuthenticationRejected: ({ resolved }) =>
              recordRejectedAttempt({ resolved, operation, occurredAt }).pipe(
                Effect.andThen(scopeMissing())
              ),
            SqlError: Effect.die,
          })
        );

      return yield* result.exit.pipe(Effect.catchTag("SqlError", Effect.die));
    }),
  })
);

/** Client-side bearer implementation derived from the same API middleware. */
export const makeAgentAuthorizationClientLive = (
  bearer: AgentBearerToken
): Layer.Layer<HttpApiMiddleware.ForClient<AgentAuthorization>> =>
  HttpApiMiddleware.layerClient(AgentAuthorization, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, bearer))
  );
