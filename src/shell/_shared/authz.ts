import { Crypto, DateTime, Effect, Encoding, Exit, Layer, Option, Redacted, Schema } from "effect";
import { HttpClientRequest, type HttpServerRequest } from "effect/unstable/http";
import type { SqlClient } from "effect/unstable/sql";
import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "effect/unstable/httpapi";
import { type AuditOutcome, CanonicalOperationId } from "~/core/audit/model";
import {
  AgentBearerToken,
  AgentBearerTokenFormat,
  type ResolvedAgentToken,
} from "~/core/tokens/model";
import { renewAgentTokenIdleExpiry } from "~/core/tokens/rules";
import { appendAuditLogEntry } from "~/shell/audit/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { AgentTokenHash, useAgentToken } from "~/shell/tokens/repo";
import { ScopeMissing, Unauthenticated } from "./errors";
import { getOperationPolicy } from "./operation-policy";

const decodeAgentBearer = Schema.decodeUnknownEffect(AgentBearerToken);

const unauthenticated = () =>
  Unauthenticated.make({
    error: {
      code: "unauthenticated",
      message:
        "Every operation requires a known AgentToken. Send its opaque fin_ bearer in the " +
        "Authorization header and retry.",
    },
    next: [],
  });

const scopeMissing = () =>
  ScopeMissing.make({
    error: {
      code: "scope_missing",
      message:
        "This AgentToken does not grant the scope declared by the attempted operation. " +
        "Ask the user in chat to mint or broaden a token before retrying.",
    },
    next: [],
  });

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

const bearerFromRequest = (request: HttpServerRequest.HttpServerRequest) =>
  Option.fromUndefinedOr(request.headers.authorization).pipe(
    Option.flatMap((authorization) =>
      Option.fromNullishOr(/^Bearer +(.+)$/i.exec(authorization)?.[1])
    ),
    Effect.fromOption(unauthenticated),
    Effect.flatMap((bearer) => decodeAgentBearer(bearer).pipe(Effect.mapError(unauthenticated)))
  );

/**
 * The handler-facing caller seam. It requires a well-formed Bearer header,
 * resolves the AgentToken to its stable User and granted scopes, and records one
 * use while renewing the idle deadline. Handlers pass the resulting UserId
 * onward explicitly. Missing, malformed, unknown, revoked, and idle-expired
 * bearers fail as `Unauthenticated`; database failures are defects.
 */
export const resolveCaller = (
  request: HttpServerRequest.HttpServerRequest
): Effect.Effect<ResolvedAgentToken, Unauthenticated, Crypto.Crypto | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const bearer = yield* bearerFromRequest(request);
    const usedAt = yield* DateTime.now;
    return yield* authenticateAgentToken({ bearer, usedAt }).pipe(
      Effect.flatMap(Effect.fromOption(unauthenticated))
    );
  });

/**
 * Security middleware attached once to the assembled API. It reads bearer
 * scope and cost exclusively from active endpoint metadata, enforces the scope,
 * and publishes the cost class for the consumption controls owned by issue #35;
 * no route identifier or path participates in authorization.
 */
export class AgentAuthorization extends HttpApiMiddleware.Service<
  AgentAuthorization,
  {
    requires: Crypto.Crypto | SqlClient.SqlClient;
  }
>()("fidy-ai/shell/_shared/authz/AgentAuthorization", {
  requiredForClient: true,
  security: {
    agentBearer: HttpApiSecurity.bearer.pipe(
      HttpApiSecurity.annotate(OpenApi.Format, AgentBearerTokenFormat)
    ),
  },
  error: [Unauthenticated, ScopeMissing],
}) {}

/**
 * Live operation-derived bearer authorization for the HTTP server. Each call
 * authenticates and renews its AgentToken, rejects a missing declared scope,
 * and appends metadata-only AuditLogEntry evidence. A successful operation and
 * its evidence commit in one SQL transaction; rejected and failed attempts
 * append their evidence separately. Authentication and scope failures remain
 * typed HTTP failures, while persistence failures are defects.
 */
export const AgentAuthorizationLive = Layer.succeed(
  AgentAuthorization,
  AgentAuthorization.of({
    agentBearer: Effect.fn(function* (httpEffect, { credential: redactedBearer, endpoint, group }) {
      const policy = getOperationPolicy(endpoint);
      const bearer = yield* decodeAgentBearer(Redacted.value(redactedBearer)).pipe(
        Effect.mapError(unauthenticated)
      );
      const occurredAt = yield* DateTime.now;
      const resolved = yield* authenticateAgentToken({ bearer, usedAt: occurredAt }).pipe(
        Effect.flatMap(Effect.fromOption(unauthenticated))
      );
      const operation = CanonicalOperationId.make(`${group.identifier}.${endpoint.identifier}`);
      const audit = (outcome: AuditOutcome) =>
        appendAuditLogEntry(resolved.subjectUserId, {
          tokenId: resolved.tokenId,
          operation,
          outcome,
          occurredAt,
        });

      if (!resolved.scopes.includes(policy.requiredScope)) {
        yield* audit("rejected");
        return yield* scopeMissing();
      }

      yield* Effect.annotateCurrentSpan({
        "fidy.operation.required_scope": policy.requiredScope,
        "fidy.operation.cost_class": policy.costClass,
      });

      const audited = withUserTransaction(
        resolved.subjectUserId,
        httpEffect.pipe(Effect.tap(() => audit("succeeded")))
      );
      const exit = yield* Effect.exit(audited);

      if (Exit.isFailure(exit)) {
        yield* audit("failed");
      }

      return yield* exit;
    }),
  })
);

/** Client-side bearer implementation derived from the same API middleware. */
export const makeAgentAuthorizationClientLive = (bearer: AgentBearerToken) =>
  HttpApiMiddleware.layerClient(AgentAuthorization, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, bearer))
  );
