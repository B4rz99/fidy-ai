import { Function, Match, Predicate } from "effect";
import type { CanonicalCapability } from "~/core/canonical-operations/contract";
import {
  type CanonicalAuthorityRoot,
  type OperationAccess,
  OperationAccessCaller,
  OperationAccessDecision,
  type OperationAccessDenial,
  type OperationPolicyValue,
  type UserOwnedAgentScopeCheck,
} from "./contract";

const isPat = OperationAccessCaller.$is("PAT");

const isOAuthAgent = OperationAccessCaller.$is("OAuthAgent");

const isUserAgent = (caller: OperationAccessCaller): boolean =>
  isPat(caller) || isOAuthAgent(caller);

const allowed: OperationAccessDecision = OperationAccessDecision.Allowed();

const denied = (reason: OperationAccessDenial): OperationAccessDecision =>
  OperationAccessDecision.Denied({ reason });

const decidePatCapability = (
  capability: CanonicalCapability,
  capabilities: ReadonlyArray<CanonicalCapability>
): OperationAccessDecision =>
  capabilities.includes(capability) ? allowed : denied("user_owned_agent_scope_missing");

const decideAgentScope = (
  scope: UserOwnedAgentScopeCheck,
  capabilities: ReadonlyArray<CanonicalCapability>
): OperationAccessDecision =>
  Predicate.isTagged(scope, "Operation")
    ? decidePatCapability(scope.capability, capabilities)
    : allowed;

const decideUserOwnedAgentScoped = (
  requirement: Readonly<{ scope: UserOwnedAgentScopeCheck }>,
  caller: OperationAccessCaller
): OperationAccessDecision => {
  if (!isPat(caller) && !isOAuthAgent(caller)) return allowed;

  return decideAgentScope(requirement.scope, caller.capabilities);
};

const decideWebSession = (caller: OperationAccessCaller): OperationAccessDecision =>
  OperationAccessCaller.$is("WebSession")(caller) ? allowed : denied("caller_ineligible");

const decideFreshWebSession = (caller: OperationAccessCaller): OperationAccessDecision => {
  if (!OperationAccessCaller.$is("WebSession")(caller)) return denied("caller_ineligible");

  return caller.fresh ? allowed : denied("fresh_web_session_required");
};

const decideHostedAuthority = (authorityRoot: CanonicalAuthorityRoot): OperationAccessDecision =>
  authorityRoot === "verified-whatsapp" ? allowed : denied("caller_ineligible");

const decideVerifiedWhatsAppHosted = (caller: OperationAccessCaller): OperationAccessDecision => {
  if (!OperationAccessCaller.$is("HostedAgentSession")(caller)) return denied("caller_ineligible");

  return decideHostedAuthority(caller.authorityRoot);
};

const decideFreshWebOrVerifiedWhatsApp = (caller: OperationAccessCaller): OperationAccessDecision =>
  OperationAccessCaller.$is("WebSession")(caller)
    ? decideFreshWebSession(caller)
    : decideVerifiedWhatsAppHosted(caller);

export const decideOperationAccess: {
  (caller: OperationAccessCaller): (self: OperationAccess) => OperationAccessDecision;
  (self: OperationAccess, caller: OperationAccessCaller): OperationAccessDecision;
} = Function.dual(2, (requirement: OperationAccess, caller: OperationAccessCaller) =>
  Match.valueTags(requirement, {
    UserOwnedAgentScoped: (scoped) => decideUserOwnedAgentScoped(scoped, caller),
    FreshWebSessionOnly: () => decideFreshWebSession(caller),
    WebSessionOnly: () => decideWebSession(caller),
    WebOrHosted: () => (isUserAgent(caller) ? denied("caller_ineligible") : allowed),
    VerifiedWhatsAppHostedOnly: () => decideVerifiedWhatsAppHosted(caller),
    FreshWebOrVerifiedWhatsAppHosted: () => decideFreshWebOrVerifiedWhatsApp(caller),
  })
);

export const isHostedVisible: {
  (authorityRoot: CanonicalAuthorityRoot): (self: OperationAccess) => boolean;
  (self: OperationAccess, authorityRoot: CanonicalAuthorityRoot): boolean;
} = Function.dual(2, (access: OperationAccess, authorityRoot: CanonicalAuthorityRoot): boolean =>
  OperationAccessDecision.$is("Allowed")(
    decideOperationAccess(access, OperationAccessCaller.HostedAgentSession({ authorityRoot }))
  )
);

export const completesHostedTurn = (policy: OperationPolicyValue): boolean => {
  if (policy.kind !== "mutation") return false;

  if (Predicate.isTagged(policy.access, "UserOwnedAgentScoped")) {
    return (
      Predicate.isTagged(policy.access.scope, "Operation") &&
      policy.access.scope.capability === "write"
    );
  }

  return (
    !Predicate.isTagged(policy.access, "FreshWebSessionOnly") &&
    !Predicate.isTagged(policy.access, "WebSessionOnly")
  );
};
