import { Function } from "effect";
import type { CanonicalCapability } from "~/core/canonical-operations/contract";
import type {
  CanonicalAuthorityRoot,
  OperationAccess,
  OperationAccessCaller,
  OperationAccessDecision,
  OperationAccessDenial,
  OperationPolicyValue,
  UserOwnedAgentScopeCheck,
} from "./contract";

const isUserAgent = (caller: OperationAccessCaller): boolean =>
  caller._tag === "PAT" || caller._tag === "OAuthAgent";
const allowed: OperationAccessDecision = { _tag: "Allowed" };
const denied = (reason: OperationAccessDenial): OperationAccessDecision => ({
  _tag: "Denied",
  reason,
});

const decidePatCapability = (
  capability: CanonicalCapability,
  capabilities: ReadonlyArray<CanonicalCapability>
): OperationAccessDecision =>
  capabilities.includes(capability) ? allowed : denied("user_owned_agent_scope_missing");

const decideAgentScope = (
  scope: UserOwnedAgentScopeCheck,
  capabilities: ReadonlyArray<CanonicalCapability>
): OperationAccessDecision => {
  if (scope._tag === "Children") return allowed;
  return decidePatCapability(scope.capability, capabilities);
};

const decideUserOwnedAgentScoped = (
  requirement: Extract<OperationAccess, { readonly _tag: "UserOwnedAgentScoped" }>,
  caller: OperationAccessCaller
): OperationAccessDecision => {
  if (caller._tag !== "PAT" && caller._tag !== "OAuthAgent") return allowed;
  return decideAgentScope(requirement.scope, caller.capabilities);
};

const decideFreshWebSession = (caller: OperationAccessCaller): OperationAccessDecision => {
  if (caller._tag !== "WebSession") return denied("caller_ineligible");
  return caller.fresh ? allowed : denied("fresh_web_session_required");
};

const decideHostedAuthority = (authorityRoot: CanonicalAuthorityRoot): OperationAccessDecision =>
  authorityRoot === "verified-whatsapp" ? allowed : denied("caller_ineligible");

const decideVerifiedWhatsAppHosted = (caller: OperationAccessCaller): OperationAccessDecision => {
  if (caller._tag !== "HostedAgentSession") return denied("caller_ineligible");
  return decideHostedAuthority(caller.authorityRoot);
};

/** Decides execution from the same closed requirement used by every derived surface. */
export const decideOperationAccess: {
  (caller: OperationAccessCaller): (self: OperationAccess) => OperationAccessDecision;
  (self: OperationAccess, caller: OperationAccessCaller): OperationAccessDecision;
} = Function.dual(2, (requirement: OperationAccess, caller: OperationAccessCaller) => {
  switch (requirement._tag) {
    case "UserOwnedAgentScoped":
      return decideUserOwnedAgentScoped(requirement, caller);
    case "FreshWebSessionOnly":
      return decideFreshWebSession(caller);
    case "WebOrHosted":
      return isUserAgent(caller) ? denied("caller_ineligible") : allowed;
    case "VerifiedWhatsAppHostedOnly":
      return decideVerifiedWhatsAppHosted(caller);
    case "FreshWebOrVerifiedWhatsAppHosted":
      return caller._tag === "WebSession"
        ? decideFreshWebSession(caller)
        : decideVerifiedWhatsAppHosted(caller);
  }
});

/** Whether a hosted caller with the given authority may discover this operation as a tool. */
export const isHostedVisible: {
  (authorityRoot: CanonicalAuthorityRoot): (self: OperationAccess) => boolean;
  (self: OperationAccess, authorityRoot: CanonicalAuthorityRoot): boolean;
} = Function.dual(
  2,
  (access: OperationAccess, authorityRoot: CanonicalAuthorityRoot): boolean =>
    decideOperationAccess(access, { _tag: "HostedAgentSession", authorityRoot })._tag === "Allowed"
);

/** Whether a successful hosted tool call completes the Turn without another model round. */
export const completesHostedTurn = (policy: OperationPolicyValue): boolean => {
  if (policy.kind !== "mutation") return false;
  if (policy.access._tag === "UserOwnedAgentScoped") {
    return policy.access.scope._tag === "Operation" && policy.access.scope.capability === "write";
  }
  return policy.access._tag !== "FreshWebSessionOnly";
};
