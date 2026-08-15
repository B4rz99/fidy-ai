import { Context, type Crypto, type DateTime, type Effect, type Layer } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import type { SqlClient } from "effect/unstable/sql";
import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "effect/unstable/httpapi";
import type { AuditOutcome, CanonicalOperationId } from "~/core/audit/model";
import { type ResolvedToken, type TokenBearer, TokenBearerFormat } from "~/core/tokens/model";
import { ConsentRequired, ScopeMissing, Unauthenticated } from "./errors";

/**
 * The request-scoped result of bearer authorization. Handlers read it once and
 * continue passing its stable UserId explicitly; core and repositories never
 * depend on request context.
 */
export class ResolvedCaller extends Context.Service<ResolvedCaller, ResolvedToken>()(
  "@fidy/server/shell/_shared/authz/ResolvedCaller"
) {}

type ChildAuditEvidence = Readonly<{
  operation: CanonicalOperationId;
  outcome: AuditOutcome;
  occurredAt: DateTime.Utc;
}>;

/**
 * Records metadata-only child outcomes for the current canonical operation. Callers provide the
 * operation, outcome, and occurrence time; recording preserves the evidence for the enclosing
 * request's audit result and does not add a failure to the caller's effect.
 */
export type ChildOperationAuditService = Readonly<{
  record: (evidence: ChildAuditEvidence) => Effect.Effect<void>;
}>;

/** Provides the request-scoped recorder used to include child outcomes in the audit result. */
export class ChildOperationAudit extends Context.Service<
  ChildOperationAudit,
  ChildOperationAuditService
>()("@fidy/server/shell/_shared/authz/ChildOperationAudit") {}

/**
 * Declares bearer authorization for canonical operations. The request context provides a resolved
 * caller and child-operation audit recorder; a derived client supplies a `ForClient` layer that
 * adds its bearer to each request.
 */
export class TokenAuthorization extends HttpApiMiddleware.Service<
  TokenAuthorization,
  {
    provides: ResolvedCaller | ChildOperationAudit;
    requires: Crypto.Crypto | SqlClient.SqlClient;
  }
>()("@fidy/server/shell/_shared/authz/TokenAuthorization", {
  requiredForClient: true,
  security: {
    agentBearer: HttpApiSecurity.bearer.pipe(
      HttpApiSecurity.annotate(OpenApi.Format, TokenBearerFormat)
    ),
  },
  error: [Unauthenticated, ConsentRequired, ScopeMissing],
}) {}

/** Lets an unauthenticated derived client call the API and receive its declared 401 response. */
export const TokenAuthorizationClientAnonymousLive: Layer.Layer<
  HttpApiMiddleware.ForClient<TokenAuthorization>
> = HttpApiMiddleware.layerClient(TokenAuthorization, ({ next, request }) => next(request));

/** Adds one opaque TokenBearer to every request made through the derived client. */
export const makeTokenAuthorizationClientLive = (
  bearer: TokenBearer
): Layer.Layer<HttpApiMiddleware.ForClient<TokenAuthorization>> =>
  HttpApiMiddleware.layerClient(TokenAuthorization, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, bearer))
  );
