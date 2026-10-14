import { Context, type Crypto, type DateTime, type Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "effect/http-api";
import type { AuditCaller, AuditOutcome } from "~/core/audit/contract";
import type {
  CanonicalCapabilities,
  CanonicalOperationId,
} from "~/core/canonical-operations/contract";
import type { UserId } from "~/core/identity/contract";
import { TokenBearerFormat } from "~/core/tokens/contract";
import {
  ConsentRequired,
  PaywallRequired,
  QuotaExhausted,
  ResourceLimited,
  ScopeMissing,
  Unauthenticated,
  Unavailable,
  UserActionRequired,
} from "~/shell/public-http/contract";
import type { CanonicalAuthorityRoot } from "~/shell/canonical-policy/contract";

/** Host-only cookie name published as part of the declaration-only browser authorization scheme. */
export const webSessionCookieName = "__Host-fidy_session";

type HostedAuditCaller = Extract<AuditCaller, { readonly _tag: "HostedAgentSession" }>;
type OAuthAuditCaller = Extract<AuditCaller, { readonly _tag: "OAuthAgent" }>;
type PatAuditCaller = Extract<AuditCaller, { readonly _tag: "PAT" }>;
type WebSessionAuditCaller = Extract<AuditCaller, { readonly _tag: "WebSession" }>;
type CanonicalAuthority =
  | Readonly<{ auditCaller: HostedAuditCaller; authorityRoot: CanonicalAuthorityRoot }>
  | Readonly<{
      auditCaller: PatAuditCaller | OAuthAuditCaller;
      authorityRoot: "no-verified-whatsapp-authority";
    }>
  | Readonly<{
      auditCaller: WebSessionAuditCaller;
      authorityRoot: "no-verified-whatsapp-authority";
      /** Freshness at this canonical operation's authorization checkpoint. */
      fresh: boolean;
    }>;

export type CanonicalCaller = Readonly<{
  subjectUserId: UserId;
  capabilities: CanonicalCapabilities;
}> &
  CanonicalAuthority;

/** Request- or Turn-scoped canonical caller; repositories still receive explicit UserId. */
export class ResolvedCaller extends Context.Service<ResolvedCaller, CanonicalCaller>()(
  "@fidy/server/shell/authorization/contract/ResolvedCaller"
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

export class ChildOperationAudit extends Context.Service<
  ChildOperationAudit,
  ChildOperationAuditService
>()("@fidy/server/shell/authorization/contract/ChildOperationAudit") {}

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
 * WebSession-or-PAT authorization. PAT is attempted first, preserving the final
 * cookie alternative's Consent or caller-policy refusal.
 *
 * @effect-expect-leaking Crypto | HttpServerRequest | ParsedSearchParams | RouteContext | SqlClient
 */
export class TokenAuthorization extends HttpApiMiddleware.Service<
  TokenAuthorization,
  {
    provides: ResolvedCaller | ChildOperationAudit;
    requires: Crypto.Crypto | SqlClient.SqlClient;
  }
>()("@fidy/server/shell/authorization/contract/TokenAuthorization", {
  requiredForClient: true,
  security: {
    agentBearer: agentBearerSecurity,
    webSession: webSessionSecurity,
  },
  error: [
    Unauthenticated,
    ConsentRequired,
    UserActionRequired,
    ScopeMissing,
    PaywallRequired,
    QuotaExhausted,
    ResourceLimited,
    Unavailable,
  ],
}) {}
