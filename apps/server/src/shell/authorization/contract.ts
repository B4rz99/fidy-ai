import { type Digest } from "effect/crypto";
import { Context, type DateTime, type Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "effect/http-api";
import type {
  AuditOutcome,
  HostedAuditCaller,
  OAuthAuditCaller,
  PatAuditCaller,
  WebSessionAuditCaller,
} from "~/core/audit/contract";
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

export const webSessionCookieName = "__Host-fidy_session";

type CanonicalAuthority =
  | Readonly<{ auditCaller: typeof HostedAuditCaller.Type; authorityRoot: CanonicalAuthorityRoot }>
  | Readonly<{
      auditCaller: typeof PatAuditCaller.Type | typeof OAuthAuditCaller.Type;
      authorityRoot: "no-verified-whatsapp-authority";
    }>
  | Readonly<{
      auditCaller: typeof WebSessionAuditCaller.Type;
      authorityRoot: "no-verified-whatsapp-authority";
      fresh: boolean;
    }>;

export type CanonicalCaller = Readonly<{
  subjectUserId: UserId;
  capabilities: CanonicalCapabilities;
}> &
  CanonicalAuthority;

export class ResolvedCaller extends Context.Service<ResolvedCaller, CanonicalCaller>()(
  "@fidy/server/shell/authorization/contract/ResolvedCaller"
) {}

type ChildAuditEvidence = Readonly<{
  operation: CanonicalOperationId;
  outcome: AuditOutcome;
  occurredAt: DateTime.Utc;
}>;

export type ChildOperationAuditService = Readonly<{
  record: (evidence: ChildAuditEvidence) => Effect.Effect<void>;
}>;

export class ChildOperationAudit extends Context.Service<
  ChildOperationAudit,
  ChildOperationAuditService
>()("@fidy/server/shell/authorization/contract/ChildOperationAudit") {}

export const webSessionSecurity = HttpApiSecurity.apiKey({
  in: "cookie",
  key: webSessionCookieName,
});

export const agentBearerSecurity = HttpApiSecurity.bearer.pipe(
  HttpApiSecurity.annotate(OpenApi.Format, TokenBearerFormat)
);

/**
 * WebSession-or-PAT authorization. PAT is attempted first, preserving the final
 * cookie alternative's Consent or caller-policy refusal.
 *
 * @effect-expect-leaking Digest | HttpServerRequest | ParsedSearchParams | RouteContext | SqlClient
 */
export class TokenAuthorization extends HttpApiMiddleware.Service<
  TokenAuthorization,
  {
    provides: ResolvedCaller | ChildOperationAudit;
    requires: Digest.Digest | SqlClient.SqlClient;
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
