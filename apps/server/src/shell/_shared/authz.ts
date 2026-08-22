import { Context, type Crypto, type DateTime, type Effect, type Layer } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import type { SqlClient } from "effect/unstable/sql";
import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "effect/unstable/httpapi";
import type { AuditCaller, AuditOutcome, CanonicalOperationId } from "~/core/audit/model";
import type { CanonicalCapabilities } from "~/core/_shared/canonical-capability";
import type { UserId } from "~/core/identity/reference";
import { type TokenBearer, TokenBearerFormat } from "~/core/tokens/model";
import { ConsentRequired, ScopeMissing, Unauthenticated, UserActionRequired } from "./errors";

/** Host-only cookie name published as part of the declaration-only browser authorization scheme. */
export const webSessionCookieName = "__Host-fidy_session";

/** Non-credential provenance retained across a hosted Turn for caller eligibility. */
export type CanonicalAuthorityRoot = "verified-whatsapp" | "no-verified-whatsapp-authority";

type HostedAuditCaller = Extract<AuditCaller, { readonly _tag: "HostedAgentSession" }>;
type PatAuditCaller = Extract<AuditCaller, { readonly _tag: "PAT" }>;
type WebSessionAuditCaller = Extract<AuditCaller, { readonly _tag: "WebSession" }>;
type CanonicalAuthority =
  | Readonly<{ auditCaller: HostedAuditCaller; authorityRoot: CanonicalAuthorityRoot }>
  | Readonly<{
      auditCaller: PatAuditCaller;
      authorityRoot: "no-verified-whatsapp-authority";
    }>
  | Readonly<{
      auditCaller: WebSessionAuditCaller;
      authorityRoot: "no-verified-whatsapp-authority";
      freshUntil: DateTime.Utc;
    }>;

/** Credential-neutral authority facts supplied to every canonical implementation. */
export type CanonicalCaller = Readonly<{
  subjectUserId: UserId;
  capabilities: CanonicalCapabilities;
}> &
  CanonicalAuthority;

/** Request- or Turn-scoped canonical caller; repositories still receive explicit UserId. */
export class ResolvedCaller extends Context.Service<ResolvedCaller, CanonicalCaller>()(
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

/** Extracts the host-only WebSession cookie for canonical first-party authorization. */
export const webSessionSecurity = HttpApiSecurity.apiKey({
  in: "cookie",
  key: webSessionCookieName,
});

/** Extracts PAT bearer credentials for canonical API authorization. */
export const agentBearerSecurity = HttpApiSecurity.bearer.pipe(
  HttpApiSecurity.annotate(OpenApi.Format, TokenBearerFormat)
);

/**
 * Declares WebSession-or-PAT authorization for canonical operations. The framework supplies the
 * request parsing context; runtime assembly supplies cryptography and the database gateway. PAT is
 * attempted first so a presented cookie is the final alternative and its declared Consent or
 * caller-policy rejection cannot be replaced by a missing-bearer authentication error.
 *
 * @effect-expect-leaking Crypto | HttpServerRequest | ParsedSearchParams | RouteContext | SqlClient
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
    agentBearer: agentBearerSecurity,
    webSession: webSessionSecurity,
  },
  error: [Unauthenticated, ConsentRequired, UserActionRequired, ScopeMissing],
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
