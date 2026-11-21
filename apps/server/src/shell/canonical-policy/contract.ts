import { Context, Data, Match, Option, Predicate, Schema, SchemaTransformation } from "effect";
import { OpenApi } from "effect/http-api";
import { CanonicalCapability } from "~/core/canonical-operations/contract";
import type { AccessTier } from "~/core/access-tier/contract";

export const AgentConfirmation = Schema.Literals(["not-required", "required"]);

export type AgentConfirmation = typeof AgentConfirmation.Type;

export const AtomicBatchEligible = Context.Reference<boolean>(
  "@fidy/server/shell/operation-policy/AtomicBatchEligible",
  { defaultValue: () => true }
);

export const CanonicalOperationKind = Schema.Literals(["query", "mutation"]);

export type CanonicalOperationKind = typeof CanonicalOperationKind.Type;

const OperationScopeCheck = Schema.TaggedStruct("Operation", { capability: CanonicalCapability });

const ChildrenScopeCheck = Schema.TaggedStruct("Children", {});

export const UserOwnedAgentScopeCheck = Schema.Union([OperationScopeCheck, ChildrenScopeCheck]);

export type UserOwnedAgentScopeCheck = typeof UserOwnedAgentScopeCheck.Type;

const UserOwnedAgentScoped = Schema.TaggedStruct("UserOwnedAgentScoped", {
  scope: UserOwnedAgentScopeCheck,
});

const FreshWebSessionOnly = Schema.TaggedStruct("FreshWebSessionOnly", {});

const WebSessionOnly = Schema.TaggedStruct("WebSessionOnly", {});

const WebOrHosted = Schema.TaggedStruct("WebOrHosted", {});

const VerifiedWhatsAppHostedOnly = Schema.TaggedStruct("VerifiedWhatsAppHostedOnly", {});

const FreshWebOrVerifiedWhatsAppHosted = Schema.TaggedStruct(
  "FreshWebOrVerifiedWhatsAppHosted",
  {}
);

const CanonicalOperationAccess = Schema.Union([
  UserOwnedAgentScoped,
  FreshWebSessionOnly,
  WebSessionOnly,
  WebOrHosted,
  VerifiedWhatsAppHostedOnly,
  FreshWebOrVerifiedWhatsAppHosted,
]);

const PublishedOperationAccessWire = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("user-owned-agent-scoped"),
    scope: Schema.Union([
      Schema.Struct({
        evaluation: Schema.Literal("operation"),
        capability: CanonicalCapability,
      }),
      Schema.Struct({ evaluation: Schema.Literal("children") }),
    ]),
  }),
  Schema.Struct({ type: Schema.Literal("fresh-web-session-only") }),
  Schema.Struct({ type: Schema.Literal("web-session-only") }),
  Schema.Struct({ type: Schema.Literal("web-or-hosted") }),
  Schema.Struct({ type: Schema.Literal("verified-whatsapp-hosted-only") }),
  Schema.Struct({ type: Schema.Literal("fresh-web-or-verified-whatsapp-hosted") }),
]);

type CanonicalOperationAccess = typeof CanonicalOperationAccess.Type;

type PublishedOperationAccessWire = typeof PublishedOperationAccessWire.Type;

const userOwnedAgentScopeCheck = (
  scope: PublishedOperationAccessWire & { readonly type: "user-owned-agent-scoped" }
): UserOwnedAgentScopeCheck =>
  scope.scope.evaluation === "operation"
    ? OperationScopeCheck.make({ capability: scope.scope.capability })
    : ChildrenScopeCheck.make({});

const decodePublishedAccess = (access: PublishedOperationAccessWire): CanonicalOperationAccess => {
  switch (access.type) {
    case "user-owned-agent-scoped":
      return UserOwnedAgentScoped.make({ scope: userOwnedAgentScopeCheck(access) });
    case "fresh-web-session-only":
      return FreshWebSessionOnly.make({});
    case "web-session-only":
      return WebSessionOnly.make({});
    case "web-or-hosted":
      return WebOrHosted.make({});
    case "verified-whatsapp-hosted-only":
      return VerifiedWhatsAppHostedOnly.make({});
    case "fresh-web-or-verified-whatsapp-hosted":
      return FreshWebOrVerifiedWhatsAppHosted.make({});
  }
};

const encodePublishedAccess = (access: CanonicalOperationAccess): PublishedOperationAccessWire =>
  Match.valueTags(access, {
    UserOwnedAgentScoped: ({ scope }): PublishedOperationAccessWire => ({
      type: "user-owned-agent-scoped",
      scope: Match.valueTags(scope, {
        Operation: ({ capability }) => ({ evaluation: "operation" as const, capability }),
        Children: () => ({ evaluation: "children" as const }),
      }),
    }),
    FreshWebSessionOnly: (): PublishedOperationAccessWire => ({ type: "fresh-web-session-only" }),
    WebSessionOnly: (): PublishedOperationAccessWire => ({ type: "web-session-only" }),
    WebOrHosted: (): PublishedOperationAccessWire => ({ type: "web-or-hosted" }),
    VerifiedWhatsAppHostedOnly: (): PublishedOperationAccessWire => ({
      type: "verified-whatsapp-hosted-only",
    }),
    FreshWebOrVerifiedWhatsAppHosted: (): PublishedOperationAccessWire => ({
      type: "fresh-web-or-verified-whatsapp-hosted",
    }),
  });

export const OperationAccess = PublishedOperationAccessWire.pipe(
  Schema.decodeTo(
    CanonicalOperationAccess,
    SchemaTransformation.transform({
      decode: decodePublishedAccess,
      encode: encodePublishedAccess,
    })
  )
);

export type OperationAccess = typeof OperationAccess.Type;

export const PublishedOperationAccess = Schema.toEncoded(OperationAccess);

export type PublishedOperationAccess = typeof PublishedOperationAccess.Type;

export type CanonicalAuthorityRoot = "verified-whatsapp" | "no-verified-whatsapp-authority";

export type OperationAccessCaller = Data.TaggedEnum<{
  PAT: { readonly capabilities: ReadonlyArray<CanonicalCapability> };
  OAuthAgent: { readonly capabilities: ReadonlyArray<CanonicalCapability> };
  WebSession: { readonly fresh: boolean };
  HostedAgentSession: { readonly authorityRoot: CanonicalAuthorityRoot };
}>;

export const OperationAccessCaller = Data.taggedEnum<OperationAccessCaller>();

export type OperationAccessDenial =
  | "user_owned_agent_scope_missing"
  | "fresh_web_session_required"
  | "caller_ineligible";

export type OperationAccessDecision = Data.TaggedEnum<{
  Allowed: {};
  Denied: { readonly reason: OperationAccessDenial };
}>;

export const OperationAccessDecision = Data.taggedEnum<OperationAccessDecision>();

export const userOwnedAgentScoped = (capability: CanonicalCapability): OperationAccess =>
  UserOwnedAgentScoped.make({ scope: OperationScopeCheck.make({ capability }) });

export const userOwnedAgentScopedChildren: OperationAccess = UserOwnedAgentScoped.make({
  scope: ChildrenScopeCheck.make({}),
});

export const freshWebSessionOnly: OperationAccess = FreshWebSessionOnly.make({});

export const webSessionOnly: OperationAccess = WebSessionOnly.make({});

export const webOrHosted: OperationAccess = WebOrHosted.make({});

export const verifiedWhatsAppHostedOnly: OperationAccess = VerifiedWhatsAppHostedOnly.make({});

export const freshWebOrVerifiedWhatsAppHosted: OperationAccess =
  FreshWebOrVerifiedWhatsAppHosted.make({});

const encodeOperationAccess = Schema.encodeSync(OperationAccess);

export const publishOperationAccess = (access: OperationAccess): PublishedOperationAccess =>
  encodeOperationAccess(access);

export const isUserOwnedAgentScoped = (access: OperationAccess): boolean =>
  Predicate.isTagged(access, "UserOwnedAgentScoped");

const scopeCapability = (scope: UserOwnedAgentScopeCheck): Option.Option<CanonicalCapability> =>
  Predicate.isTagged(scope, "Operation") ? Option.some(scope.capability) : Option.none();

export const userOwnedAgentCapability = (
  access: OperationAccess
): Option.Option<CanonicalCapability> =>
  Predicate.isTagged(access, "UserOwnedAgentScoped")
    ? scopeCapability(access.scope)
    : Option.none();

export type OperationPolicyValue = {
  readonly access: OperationAccess;
  readonly requiredTier: AccessTier;
  readonly agentConfirmation: AgentConfirmation;
  readonly kind: CanonicalOperationKind;
};

export class OperationPolicy extends Context.Service<OperationPolicy, OperationPolicyValue>()(
  "@fidy/server/shell/canonical-policy/contract/OperationPolicy"
) {}

type PolicyAnnotatedOperation = {
  readonly annotations: Context.Context<never>;
};

export const getOperationPolicy = (endpoint: PolicyAnnotatedOperation): OperationPolicyValue =>
  Context.getUnsafe(endpoint.annotations, OperationPolicy);

export const operationPolicy = (
  policy: OperationPolicyValue
): Context.Context<OperationPolicy | OpenApi.Override> =>
  Context.make(OperationPolicy, policy).pipe(
    Context.add(OpenApi.Override, {
      "x-fidy-access": publishOperationAccess(policy.access),
      "x-fidy-required-tier": policy.requiredTier,
      "x-fidy-agent-confirmation": policy.agentConfirmation,
      "x-fidy-operation-kind": policy.kind,
    })
  );
